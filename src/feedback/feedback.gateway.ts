// Use console.* for tracing so logs are visible even when Nest logger is disabled.
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { Prisma, UserRole } from '@prisma/client';
import type { FeedbackSeverity, FeedbackType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuthJwtService } from '../auth/jwt.service';
import {
  assertTenantMatch,
  requireTenant,
} from '../tenancy/tenant-context.service';
import type { TenantContext } from '../tenancy/tenant-context.types';

interface SocketData {
  ctx: TenantContext;
}

type AuthSocket = Socket<any, any, any, SocketData>;

@WebSocketGateway({
  cors: {
    // Mirror the HTTP CORS policy set in main.ts — single source of truth
    // (CORS_ORIGINS). In production, empty env means "refuse all" (same as
    // `parseCorsOrigins` in main.ts). In dev, empty env means "allow all"
    // to keep Electron/webview DX.
    origin: (origin, cb) => {
      const allow = (process.env.CORS_ORIGINS || '').trim();
      const isProd = process.env.NODE_ENV === 'production';
      if (!allow) {
        if (isProd) {
          return cb(new Error('Origin not allowed'), false);
        }
        return cb(null, true);
      }
      const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.includes('*')) {
        return cb(null, true);
      }
      // Socket.IO may call us without Origin (Node client, CLI). Deny in
      // production; allow in dev for debugging tools.
      if (!origin) {
        return cb(isProd ? new Error('Origin required') : null, !isProd);
      }
      if (list.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
  },
  transports: ['websocket'],
})
export class FeedbackGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: AuthJwtService,
  ) {}

  @WebSocketServer()
  server: Server;

  private readonly rooms = new Map<string, Set<string>>(); // room -> Set<socketId>

  afterInit(server: Server) {
    // Handshake authentication — single source of truth for `socket.data.ctx`.
    server.use((socket: AuthSocket, next) => {
      try {
        const token = extractSocketToken(socket);
        if (!token) {
          return next(new Error('unauthorized: missing token'));
        }
        const claims = this.jwt.verify(token, 'access');
        const ctx: TenantContext = Object.freeze({
          userId: claims.sub,
          tenantId: claims.tid,
          role: claims.role as UserRole,
          jti: claims.jti,
        });
        // `socket.data` is the ONLY authoritative context during the lifetime
        // of the socket. We purposely do NOT use AsyncLocalStorage here —
        // handler callbacks run out of the initial async scope and ALS leak
        // between concurrent connections is a real risk.
        socket.data.ctx = ctx;
        next();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unauthorized';
        console.warn(`[FeedbackGateway] handshake rejected: ${msg}`);
        next(new Error('unauthorized'));
      }
    });
  }

  handleConnection(client: AuthSocket) {
    const ctx = client.data?.ctx;
    console.log(
      `[FeedbackGateway] connected socket=${client.id} user=${ctx?.userId} tenant=${ctx?.tenantId}`,
    );
  }

  handleDisconnect(client: AuthSocket) {
    console.log(`[FeedbackGateway] disconnected socket=${client.id}`);
    for (const [room, clients] of this.rooms.entries()) {
      if (clients.has(client.id)) {
        clients.delete(client.id);
        if (clients.size === 0) {
          this.rooms.delete(room);
        }
      }
    }
  }

  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    // Re-read context on every event — socket.data is immutable after handshake
    // but reading it here guarantees we never depend on async local state.
    const ctx = client.data?.ctx;
    if (!ctx) {
      console.warn(
        `[FeedbackGateway] join-room without ctx socket=${client.id}`,
      );
      client.disconnect(true);
      return;
    }
    const tenantId = requireTenant(ctx, 'feedback.join-room');

    const { meetingId, claimedTenantId } = parseJoinPayload(payload);
    if (!meetingId) {
      console.warn(
        `[FeedbackGateway] join-room invalid payload socket=${client.id}`,
      );
      return;
    }
    if (claimedTenantId) {
      try {
        assertTenantMatch(tenantId, claimedTenantId);
      } catch (err) {
        console.warn(
          `[FeedbackGateway] tenant mismatch socket=${client.id} token=${tenantId} claimed=${claimedTenantId}`,
        );
        client.emit('error', { code: 'TENANT_MISMATCH' });
        return;
      }
    }

    const roomName = `feedback:${tenantId}:${meetingId}`;

    // Leave previous rooms for this socket.
    for (const [existingRoom, clients] of this.rooms.entries()) {
      if (clients.has(client.id)) {
        client.leave(existingRoom);
        clients.delete(client.id);
        if (clients.size === 0) {
          this.rooms.delete(existingRoom);
        }
      }
    }

    client.join(roomName);
    if (!this.rooms.has(roomName)) {
      this.rooms.set(roomName, new Set());
    }
    this.rooms.get(roomName)?.add(client.id);

    console.log(
      `[FeedbackGateway] ${client.id} joined ${roomName} (tenant=${tenantId})`,
    );

    let recent: Array<Record<string, unknown>> = [];
    try {
      recent = await this.loadRecentFeedback(tenantId, meetingId);
    } catch (error) {
      console.error(
        `[FeedbackGateway] failed to load recent feedback for tenant=${tenantId} meetingId=${meetingId}`,
        error,
      );
    }

    client.emit('room-joined', {
      room: roomName,
      tenantId,
      meetingId,
      recent,
    });

    console.log(
      `[FeedbackGateway] room-joined ack client=${client.id} room=${roomName} recent=${recent.length}`,
    );
  }

  broadcastFeedback(room: string, payload: Record<string, unknown>) {
    this.server.to(room).emit('feedback', payload);
    const type = (payload as any).type;
    const severity = (payload as any).severity;
    const message = (payload as any).message;
    console.log(
      `[FeedbackGateway] broadcasted 'feedback' room=${room} type=${String(
        type,
      )} severity=${String(severity)} message="${String(message)}"`,
    );
  }

  private async loadRecentFeedback(
    tenantId: string,
    meetingId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await (
      this.prisma as unknown as {
        feedbackEvent: {
          findMany: (args: {
            where: { tenantId: string; meetingId: string };
            orderBy: { createdAt: 'desc' };
            take: number;
            select: Record<string, boolean>;
          }) => Promise<
            Array<{
              id: string;
              tenantId: string;
              meetingId: string;
              participantId: string;
              type: FeedbackType;
              severity: FeedbackSeverity;
              ts: Date;
              createdAt: Date;
              windowStart: Date;
              windowEnd: Date;
              message: string;
              metadata: Prisma.JsonValue;
            }>
          >;
        };
      }
    ).feedbackEvent.findMany({
      where: { tenantId, meetingId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        tenantId: true,
        meetingId: true,
        participantId: true,
        type: true,
        severity: true,
        ts: true,
        createdAt: true,
        windowStart: true,
        windowEnd: true,
        message: true,
        metadata: true,
      },
    });

    return rows
      .map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        meetingId: row.meetingId,
        participantId: row.participantId,
        type: row.type,
        severity: row.severity,
        ts: row.ts.toISOString(),
        createdAt: row.createdAt.toISOString(),
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
        message: row.message,
        metadata: row.metadata as Record<string, unknown> | null,
      }))
      .reverse();
  }
}

function extractSocketToken(socket: AuthSocket): string | null {
  const authToken =
    (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
  if (typeof authToken === 'string' && authToken) return authToken;
  const authHeader =
    socket.handshake.headers.authorization ??
    socket.handshake.headers.Authorization;
  if (typeof authHeader === 'string') {
    const [scheme, token] = authHeader.split(' ');
    if (scheme && scheme.toLowerCase() === 'bearer' && token) {
      return token.trim() || null;
    }
  }
  const queryToken = socket.handshake.query?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

function parseJoinPayload(payload: unknown): {
  meetingId: string | null;
  claimedTenantId: string | null;
} {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return { meetingId: null, claimedTenantId: null };
    // Legacy: "feedback:<meetingId>" — we ignore the prefix and extract meetingId.
    const feedbackPrefix = 'feedback:';
    if (trimmed.startsWith(feedbackPrefix)) {
      return {
        meetingId: trimmed.slice(feedbackPrefix.length).trim() || null,
        claimedTenantId: null,
      };
    }
    return { meetingId: trimmed, claimedTenantId: null };
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const meetingId =
      typeof obj.meetingId === 'string' ? obj.meetingId.trim() : '';
    const claimedTenantId =
      typeof obj.tenantId === 'string' ? obj.tenantId.trim() : '';
    return {
      meetingId: meetingId || null,
      claimedTenantId: claimedTenantId || null,
    };
  }
  return { meetingId: null, claimedTenantId: null };
}
