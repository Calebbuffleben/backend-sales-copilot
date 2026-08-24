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

import { AuthJwtService } from '../auth/jwt.service';
import { canAccessManagerFloor } from '../auth/role.types';
import {
  assertTenantMatch,
  requireTenant,
} from '../tenancy/tenant-context.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import type { MeetingSnapshot } from './monitor.types';

interface SocketData {
  ctx: TenantContext;
}

type AuthSocket = Socket<any, any, any, SocketData>;

@WebSocketGateway({
  namespace: '/monitor',
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
      if (!origin) {
        return cb(isProd ? new Error('Origin required') : null, !isProd);
      }
      if (list.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
  },
  transports: ['websocket'],
})
export class MonitorGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  constructor(private readonly jwt: AuthJwtService) {}

  @WebSocketServer()
  server: Server;

  afterInit(server: Server) {
    server.use((socket: AuthSocket, next) => {
      try {
        const token = extractSocketToken(socket);
        if (!token) return next(new Error('unauthorized: missing token'));
        const claims = this.jwt.verify(token, 'access');
        if (!canAccessManagerFloor(claims.role)) {
          return next(new Error('forbidden: manager access required'));
        }
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
        console.warn(`[MonitorGateway] handshake rejected: ${msg}`);
        next(new Error('unauthorized'));
      }
    });
  }

  handleConnection(client: AuthSocket) {
    const ctx = client.data?.ctx;
    console.log(
      `[MonitorGateway] connected socket=${client.id} user=${ctx?.userId} tenant=${ctx?.tenantId}`,
    );
  }

  handleDisconnect(client: AuthSocket) {
    console.log(`[MonitorGateway] disconnected socket=${client.id}`);
  }

  @SubscribeMessage('join-floor')
  handleJoinFloor(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() payload: unknown,
  ) {
    const ctx = client.data?.ctx;
    if (!ctx) {
      client.disconnect(true);
      return;
    }
    const tenantId = requireTenant(ctx, 'monitor.join-floor');
    const claimed =
      payload && typeof payload === 'object'
        ? String((payload as { tenantId?: string }).tenantId || '')
        : '';
    if (claimed) {
      try {
        assertTenantMatch(tenantId, claimed);
      } catch {
        client.emit('error', { code: 'TENANT_MISMATCH' });
        return;
      }
    }
    const room = floorRoom(tenantId);
    client.join(room);
    client.emit('floor-joined', { room, tenantId });
  }

  broadcastSnapshot(tenantId: string, snapshot: MeetingSnapshot) {
    if (!this.server) return;
    this.server.to(floorRoom(tenantId)).emit('meeting-snapshot', snapshot);
  }

  broadcastAlert(
    tenantId: string,
    alert: {
      id: string;
      meetingId: string;
      kind: 'red' | 'yellow' | 'sos';
      message: string;
      createdAt: string;
    },
  ) {
    if (!this.server) return;
    this.server.to(floorRoom(tenantId)).emit('alert', alert);
  }

  broadcastMeetingEnded(tenantId: string, meetingId: string) {
    if (!this.server) return;
    this.server.to(floorRoom(tenantId)).emit('meeting-ended', { meetingId });
  }
}

function floorRoom(tenantId: string): string {
  return `monitor:floor:${tenantId}`;
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
