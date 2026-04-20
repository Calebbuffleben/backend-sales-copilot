import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Server, IncomingMessage } from 'http';
import * as WebSocket from 'ws';
import type { Socket } from 'net';
import { PipelineService, AudioChunkMeta } from '../pipeline/pipeline.service';
import { AuthJwtService } from '../auth/jwt.service';
import {
  assertTenantMatch,
  requireTenant,
} from '../tenancy/tenant-context.service';
import type { TenantContext } from '../tenancy/tenant-context.types';

interface EgressConnection {
  ws: WebSocket;
  /** Authenticated context frozen at upgrade time. Never re-read from the
   *  URL/headers afterwards — closure captures it per-connection. */
  ctx: TenantContext;
  room: string;
  meetingId: string;
  participant: string;
  track: string;
  sampleRate: number;
  channels: number;
  bytesReceived: number;
  chunksReceived: number;
  connectedAt: Date;
  lastChunkAt: Date;
  lastIngressLogAt: number;
}

@Injectable()
export class EgressAudioGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EgressAudioGateway.name);
  private wss: WebSocket.Server | null = null;
  private connections = new Map<WebSocket, EgressConnection>();
  private httpServer: Server | null = null;

  constructor(
    private readonly pipelineService: PipelineService,
    private readonly jwt: AuthJwtService,
  ) {}

  setHttpServer(server: Server) {
    this.httpServer = server;
    this.initializeWebSocket();
  }

  onModuleInit() {
    // WebSocket is initialized when HTTP server is ready via setHttpServer().
  }

  private initializeWebSocket() {
    if (!this.httpServer) {
      this.logger.warn('HTTP server not set, WebSocket server not initialized');
      return;
    }

    this.wss = new WebSocket.Server({
      noServer: true,
      perMessageDeflate: false,
    });

    this.httpServer.on(
      'upgrade',
      (request: IncomingMessage, socket: Socket, head: Buffer) => {
        const pathname = request.url ? request.url.split('?')[0] : '';
        if (pathname !== '/egress-audio') return;

        // --- Authentication BEFORE upgrade ---
        const token = extractTokenFromUpgrade(request);
        if (!token) {
          abortUpgrade(socket, 401, 'missing token');
          return;
        }

        let ctx: TenantContext;
        try {
          const claims = this.jwt.verify(token, 'access');
          ctx = Object.freeze({
            userId: claims.sub,
            tenantId: claims.tid,
            role: claims.role as TenantContext['role'],
            jti: claims.jti,
          });
        } catch (err) {
          this.logger.warn(
            `WS /egress-audio upgrade rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
          abortUpgrade(socket, 401, 'invalid token');
          return;
        }

        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.handleConnection(ws as WebSocket, request, ctx);
        });
      },
    );
  }

  onModuleDestroy() {
    if (this.wss) {
      this.wss.close();
    }
  }

  private handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
    ctx: TenantContext,
  ) {
    const url = new URL(req.url || '/', 'http://localhost');
    const meetingId = (url.searchParams.get('meetingId') || '').trim();
    const participant = url.searchParams.get('participant') || 'browser';
    const track = url.searchParams.get('track') || 'webrtc-audio';
    const sampleRate = parseInt(
      url.searchParams.get('sampleRate') || '16000',
      10,
    );
    const channels = parseInt(url.searchParams.get('channels') || '1', 10);
    const claimedTenantId = url.searchParams.get('tenantId') || '';

    if (!meetingId) {
      this.logger.error('Missing required query parameter: meetingId');
      ws.close(1008, 'Missing meetingId');
      return;
    }

    try {
      requireTenant(ctx, 'egress-audio.upgrade');
      assertTenantMatch(ctx.tenantId, claimedTenantId || null);
    } catch (err) {
      this.logger.warn(
        `WS /egress-audio tenant mismatch: token=${ctx.tenantId} claimed=${claimedTenantId}`,
      );
      ws.close(1008, 'tenant mismatch');
      return;
    }

    const connection: EgressConnection = {
      ws,
      ctx,
      room: `${ctx.tenantId}:${meetingId}`,
      meetingId,
      participant,
      track,
      sampleRate,
      channels,
      bytesReceived: 0,
      chunksReceived: 0,
      connectedAt: new Date(),
      lastChunkAt: new Date(),
      lastIngressLogAt: 0,
    };

    this.connections.set(ws, connection);

    this.logger.log(
      `WS /egress-audio connected | tenant=${ctx.tenantId} user=${ctx.userId} meetingId=${meetingId} | participant=${participant} | track=${track} | ${sampleRate}Hz/${channels}ch`,
    );

    // ⚠️ Context capture via closure — NEVER re-read tenantId from the URL or
    // headers in these handlers, and NEVER trust AsyncLocalStorage here. The
    // `ws` library keeps these callbacks alive for the full lifetime of the
    // connection and they are intercalated across concurrent tenants.
    ws.on('message', (data: WebSocket.Data) => {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        this.handleAudioData(connection, data);
      }
    });

    ws.on('error', (error) => {
      this.logger.error(
        `❌ WebSocket ERROR | tenant=${ctx.tenantId} meetingId=${meetingId} | participant=${participant} | error=${error.message || error}`,
        error.stack || '',
      );
    });

    ws.on('close', (code, _reason) => {
      const conn = this.connections.get(ws);
      if (conn) {
        const duration = Date.now() - conn.connectedAt.getTime();
        this.logger.log(
          `WS /egress-audio closed | tenant=${conn.ctx.tenantId} meetingId=${conn.meetingId} | chunks=${conn.chunksReceived} | bytes=${conn.bytesReceived} | durationMs=${duration} | code=${code}`,
        );
        this.connections.delete(ws);
      }
    });
  }

  private handleAudioData(
    connection: EgressConnection,
    data: Buffer | ArrayBuffer,
  ) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const chunkSize = buffer.length;
    const now = new Date();

    connection.bytesReceived += chunkSize;
    connection.chunksReceived += 1;
    connection.lastChunkAt = now;

    const { ctx, meetingId, participant } = connection;
    if (connection.chunksReceived === 1) {
      const bytesPerSec = connection.sampleRate * connection.channels * 2;
      this.logger.log(
        `First audio chunk | tenant=${ctx.tenantId} meetingId=${meetingId} | participant=${participant} | bytes=${chunkSize} | sampleRate=${connection.sampleRate} | channels=${connection.channels} | s16leBytesPerSec=${bytesPerSec}`,
      );
      connection.lastIngressLogAt = now.getTime();
    } else {
      const periodMs = 5_000;
      const t = now.getTime();
      if (t - connection.lastIngressLogAt >= periodMs) {
        connection.lastIngressLogAt = t;
        this.logger.log(
          `Audio ingress | tenant=${ctx.tenantId} meetingId=${meetingId} | chunks=${connection.chunksReceived} | bytes=${connection.bytesReceived} | lastChunk=${chunkSize}b`,
        );
      }
    }

    const meta: AudioChunkMeta = {
      tenantId: connection.ctx.tenantId,
      userId: connection.ctx.userId,
      meetingId: connection.meetingId,
      participant: connection.participant,
      track: connection.track,
      sampleRate: connection.sampleRate,
      channels: connection.channels,
    };

    try {
      this.pipelineService.enqueueChunk(buffer, meta);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue audio chunk: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getConnectionsByMeeting(meetingId: string): EgressConnection[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.meetingId === meetingId,
    );
  }

  getConnectionStats(): {
    totalConnections: number;
    totalBytesReceived: number;
    totalChunksReceived: number;
    connections: Array<{
      tenantId: string;
      meetingId: string;
      participant: string;
      bytesReceived: number;
      chunksReceived: number;
      duration: number;
    }>;
  } {
    const connections = Array.from(this.connections.values());
    const now = Date.now();

    return {
      totalConnections: connections.length,
      totalBytesReceived: connections.reduce(
        (sum, conn) => sum + conn.bytesReceived,
        0,
      ),
      totalChunksReceived: connections.reduce(
        (sum, conn) => sum + conn.chunksReceived,
        0,
      ),
      connections: connections.map((conn) => ({
        tenantId: conn.ctx.tenantId,
        meetingId: conn.meetingId,
        participant: conn.participant,
        bytesReceived: conn.bytesReceived,
        chunksReceived: conn.chunksReceived,
        duration: now - conn.connectedAt.getTime(),
      })),
    };
  }
}

function extractTokenFromUpgrade(req: IncomingMessage): string | null {
  const authHeader =
    req.headers['authorization'] ?? req.headers['Authorization'.toLowerCase()];
  if (typeof authHeader === 'string') {
    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
      return token.trim() || null;
    }
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const qs = url.searchParams.get('token');
    if (qs) return qs;
  } catch {
    /* noop */
  }
  // Sec-WebSocket-Protocol can carry the token for browser-like clients that
  // cannot set Authorization headers on upgrade requests.
  const swp = req.headers['sec-websocket-protocol'];
  if (typeof swp === 'string') {
    const match = swp.split(',').map((s) => s.trim());
    const bearer = match.find((p) => p.toLowerCase().startsWith('bearer.'));
    if (bearer) return bearer.slice('bearer.'.length) || null;
  }
  return null;
}

function abortUpgrade(socket: Socket, code: number, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    /* noop */
  }
  socket.destroy();
}
