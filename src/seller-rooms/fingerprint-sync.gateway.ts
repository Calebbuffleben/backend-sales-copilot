import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SellerRoomStatus } from '@prisma/client';

import { AuthJwtService } from '../auth/jwt.service';
import {
  assertTenantMatch,
  requireTenant,
} from '../tenancy/tenant-context.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { FingerprintCacheService } from './fingerprint-cache';
import {
  SellerAudioFingerprintService,
  type WireFingerprint,
} from './seller-audio-fingerprint.service';
import { SellerRoomsService } from './seller-rooms.service';

interface SocketData {
  ctx: TenantContext;
  sellerRoomId?: string;
}

type AuthSocket = Socket<any, any, any, SocketData>;

const RATE_LIMIT_PER_SEC = 10;
const RATE_BURST = 20;

@WebSocketGateway({
  namespace: '/seller-room',
  cors: {
    origin: (origin, cb) => {
      const allow = (process.env.CORS_ORIGINS || '').trim();
      const isProd = process.env.NODE_ENV === 'production';
      if (!allow) {
        if (isProd) return cb(new Error('Origin not allowed'), false);
        return cb(null, true);
      }
      const list = allow.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.includes('*')) return cb(null, true);
      if (!origin) return cb(isProd ? new Error('Origin required') : null, !isProd);
      if (list.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
  },
  transports: ['websocket'],
})
export class FingerprintSyncGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    private readonly jwt: AuthJwtService,
    private readonly rooms: SellerRoomsService,
    private readonly fingerprints: SellerAudioFingerprintService,
    private readonly cache: FingerprintCacheService,
  ) {}

  @WebSocketServer()
  server: Server;

  private readonly rateBuckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();
  private readonly metrics = {
    publishes: 0,
    publishesRejected: 0,
    joins: 0,
  };

  afterInit(server: Server) {
    server.use((socket: AuthSocket, next) => {
      try {
        const token = extractSocketToken(socket);
        if (!token) return next(new Error('unauthorized: missing token'));
        const claims = this.jwt.verify(token, 'access');
        socket.data.ctx = Object.freeze({
          userId: claims.sub,
          tenantId: claims.tid!,
          membershipId: claims.mid ?? null,
          role: claims.role,
          jti: claims.jti,
        });
        next();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unauthorized';
        console.warn(`[FingerprintSyncGateway] handshake rejected: ${msg}`);
        next(new Error('unauthorized'));
      }
    });
  }

  handleConnection(client: AuthSocket) {
    const ctx = client.data?.ctx;
    console.log(
      `[FingerprintSyncGateway] connected socket=${client.id} user=${ctx?.userId}`,
    );
  }

  async handleDisconnect(client: AuthSocket) {
    const ctx = client.data?.ctx;
    const roomId = client.data?.sellerRoomId;
    if (ctx && roomId) {
      await this.cache.removePresence(ctx.tenantId, roomId, ctx.userId);
      await this.broadcastPresence(ctx.tenantId, roomId);
    }
  }

  @SubscribeMessage('join-seller-room')
  async handleJoin(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const ctx = client.data?.ctx;
    if (!ctx) {
      client.disconnect(true);
      return;
    }
    const tenantId = requireTenant(ctx, 'seller-room.join');
    const body = asObject(payload);
    const sellerRoomId = String(body.sellerRoomId ?? '').trim();
    const meetingId = String(body.meetingId ?? '').trim();
    const claimedTenantId = body.tenantId
      ? String(body.tenantId).trim()
      : null;
    if (!sellerRoomId || !meetingId) {
      client.emit('error', { message: 'sellerRoomId and meetingId required' });
      return;
    }
    if (claimedTenantId) {
      assertTenantMatch(tenantId, claimedTenantId);
    }

    try {
      await this.fingerprints.assertRedisReady();
      const room = await this.rooms.assertJoinedMember(
        tenantId,
        ctx.userId,
        sellerRoomId,
      );
      if (room.meetingId !== meetingId) {
        client.emit('error', { message: 'meetingId mismatch' });
        return;
      }

      if (client.data.sellerRoomId) {
        await client.leave(socketRoom(tenantId, client.data.sellerRoomId));
      }
      client.data.sellerRoomId = sellerRoomId;
      const roomName = socketRoom(tenantId, sellerRoomId);
      await client.join(roomName);
      await this.cache.setPresence(
        tenantId,
        sellerRoomId,
        ctx.userId,
        client.id,
      );

      if (room.status === SellerRoomStatus.OPEN) {
        await this.rooms.join(tenantId, ctx.userId, sellerRoomId);
      }

      const memberIds = await this.rooms.listJoinedMemberIds(
        tenantId,
        sellerRoomId,
      );
      const presence = await this.cache.getPresence(tenantId, sellerRoomId);
      const fingerprintSnapshot = await this.fingerprints.snapshot(
        tenantId,
        sellerRoomId,
        memberIds.filter((id) => id !== ctx.userId),
      );

      this.metrics.joins += 1;
      client.emit('seller-room-joined', {
        type: 'seller-room-joined',
        sellerRoomId,
        meetingId,
        members: memberIds,
        presence: Object.keys(presence),
        fingerprintSnapshot,
        serverTimeMs: Date.now(),
      });
      await this.broadcastPresence(tenantId, sellerRoomId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'join failed';
      client.emit('error', { message });
    }
  }

  @SubscribeMessage('clock-sync')
  handleClockSync(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const body = asObject(payload);
    const clientTimeMs = Number(body.clientTimeMs);
    client.emit('clock-sync-response', {
      type: 'clock-sync-response',
      clientTimeMs: Number.isFinite(clientTimeMs) ? clientTimeMs : 0,
      serverTimeMs: Date.now(),
    });
  }

  @SubscribeMessage('heartbeat')
  async handleHeartbeat(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const ctx = client.data?.ctx;
    if (!ctx) return;
    const body = asObject(payload);
    const sellerRoomId =
      String(body.sellerRoomId ?? client.data.sellerRoomId ?? '').trim();
    if (!sellerRoomId) return;
    await this.cache.setPresence(
      ctx.tenantId,
      sellerRoomId,
      ctx.userId,
      client.id,
    );
  }

  @SubscribeMessage('fingerprint-publish')
  async handlePublish(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const ctx = client.data?.ctx;
    if (!ctx) {
      client.disconnect(true);
      return;
    }
    const tenantId = requireTenant(ctx, 'seller-room.publish');
    const body = asObject(payload);
    const sellerRoomId = String(
      body.sellerRoomId ?? client.data.sellerRoomId ?? '',
    ).trim();
    if (!sellerRoomId) {
      client.emit('error', { message: 'sellerRoomId required' });
      return;
    }

    if (!this.consumeRateToken(ctx.userId)) {
      this.metrics.publishesRejected += 1;
      client.emit('error', { message: 'rate limit exceeded' });
      return;
    }

    try {
      const room = await this.rooms.assertJoinedMember(
        tenantId,
        ctx.userId,
        sellerRoomId,
      );
      const normalized = this.fingerprints.validateAndNormalize(
        body.fingerprint,
        {
          expectedUserId: ctx.userId,
          expectedRoomId: sellerRoomId,
          expectedMeetingId: room.meetingId,
        },
      );
      const monoOk = await this.fingerprints.checkMonotonicSeq(
        tenantId,
        sellerRoomId,
        ctx.userId,
        normalized.seq,
      );
      if (!monoOk) {
        this.metrics.publishesRejected += 1;
        client.emit('error', { message: 'non-monotonic seq' });
        return;
      }

      const serverTimeMs = Date.now();
      const stamped: WireFingerprint = {
        ...normalized,
        captureServerMs: serverTimeMs,
      };

      // Live broadcast first — do not wait for cache.
      client.to(socketRoom(tenantId, sellerRoomId)).emit('fingerprint-received', {
        type: 'fingerprint-received',
        fingerprint: stamped,
        serverTimeMs,
      });

      this.fingerprints.enqueueForCache(
        tenantId,
        sellerRoomId,
        ctx.userId,
        stamped,
      );
      this.metrics.publishes += 1;
    } catch (err) {
      this.metrics.publishesRejected += 1;
      const message = err instanceof Error ? err.message : 'publish failed';
      client.emit('error', { message });
    }
  }

  @SubscribeMessage('end-seller-room')
  async handleEnd(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const ctx = client.data?.ctx;
    if (!ctx) return;
    const tenantId = requireTenant(ctx, 'seller-room.end');
    const body = asObject(payload);
    const sellerRoomId = String(body.sellerRoomId ?? '').trim();
    if (!sellerRoomId) return;
    try {
      await this.rooms.end(tenantId, ctx.userId, sellerRoomId);
      this.emitRoomEnded(tenantId, sellerRoomId, 'creator_ended');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'end failed';
      client.emit('error', { message });
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  /** Broadcast room end from lifecycle / REST (not only Socket.IO handler). */
  emitRoomEnded(
    tenantId: string,
    sellerRoomId: string,
    reason: string,
  ): void {
    this.server
      ?.to(socketRoom(tenantId, sellerRoomId))
      .emit('seller-room-ended', {
        type: 'seller-room-ended',
        sellerRoomId,
        reason,
      });
  }

  private async broadcastPresence(
    tenantId: string,
    sellerRoomId: string,
  ): Promise<void> {
    const presence = await this.cache.getPresence(tenantId, sellerRoomId);
    this.server
      ?.to(socketRoom(tenantId, sellerRoomId))
      .emit('presence-updated', {
        type: 'presence-updated',
        sellerRoomId,
        onlineUserIds: Object.keys(presence),
        onlineCount: Object.keys(presence).length,
      });
  }

  private consumeRateToken(userId: string): boolean {
    const now = Date.now();
    const bucket = this.rateBuckets.get(userId) ?? {
      tokens: RATE_BURST,
      updatedAt: now,
    };
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      RATE_BURST,
      bucket.tokens + elapsedSec * RATE_LIMIT_PER_SEC,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.rateBuckets.set(userId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.rateBuckets.set(userId, bucket);
    return true;
  }
}

function socketRoom(tenantId: string, sellerRoomId: string): string {
  return `seller-room:${tenantId}:${sellerRoomId}`;
}

function asObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  return payload as Record<string, unknown>;
}

function extractSocketToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: string } | undefined;
  if (auth?.token) return auth.token;
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const query = socket.handshake.query.token;
  if (typeof query === 'string' && query.trim()) return query.trim();
  return null;
}
