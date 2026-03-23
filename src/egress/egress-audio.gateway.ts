import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Server } from 'http';
import * as WebSocket from 'ws';
import { PipelineService, AudioChunkMeta } from '../pipeline/pipeline.service';

interface EgressConnection {
  ws: WebSocket;
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
  /** Throttle INFO logs for ingress progress (not only first chunk). */
  lastIngressLogAt: number;
}

@Injectable()
export class EgressAudioGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EgressAudioGateway.name);
  private wss: WebSocket.Server | null = null;
  private connections = new Map<WebSocket, EgressConnection>();
  private httpServer: Server | null = null;

  constructor(private readonly pipelineService: PipelineService) {}

  setHttpServer(server: Server) {
    this.httpServer = server;
    this.initializeWebSocket();
  }

  onModuleInit() {
    // WebSocket will be initialized when HTTP server is ready
    // via setHttpServer() called from main.ts
  }

  private initializeWebSocket() {
    if (!this.httpServer) {
      this.logger.warn('HTTP server not set, WebSocket server not initialized');
      return;
    }

    // Create WebSocket server on the same HTTP server
    this.wss = new WebSocket.Server({
      server: this.httpServer,
      path: '/egress-audio',
      perMessageDeflate: false, // Disable compression for binary data
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req);
    });
  }

  onModuleDestroy() {
    if (this.wss) {
      this.wss.close();
    }
  }

  private handleConnection(ws: WebSocket, req: { url?: string }) {
    const url = new URL(req.url || '/', 'http://localhost');
    const room = url.searchParams.get('room') || '';
    const meetingId = url.searchParams.get('meetingId') || room;
    // participant is optional now (shared connection mode)
    const participant = url.searchParams.get('participant') || 'browser';
    const track = url.searchParams.get('track') || 'webrtc-audio';
    const sampleRate = parseInt(
      url.searchParams.get('sampleRate') || '16000',
      10,
    );
    const channels = parseInt(url.searchParams.get('channels') || '1', 10);

    if (!meetingId) {
      this.logger.error(`Missing required query parameter: meetingId`);
      ws.close(1008, 'Missing meetingId');
      return;
    }

    const connection: EgressConnection = {
      ws,
      room,
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
      `WS /egress-audio connected | meetingId=${meetingId} | participant=${participant} | track=${track} | ${sampleRate}Hz/${channels}ch`,
    );

    // Handle binary audio data
    ws.on('message', (data: WebSocket.Data) => {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        this.handleAudioData(connection, data);
      }
    });

    ws.on('error', (error) => {
      const conn = this.connections.get(ws);
      const meetingId = conn?.meetingId || 'unknown';
      this.logger.error(
        `❌ WebSocket ERROR | meetingId=${meetingId} | participant=${participant} | error=${error.message || error}`,
        error.stack || '',
      );
    });

    ws.on('close', (code, reason) => {
      const conn = this.connections.get(ws);
      if (conn) {
        const duration = Date.now() - conn.connectedAt.getTime();
        this.logger.log(
          `WS /egress-audio closed | meetingId=${conn.meetingId} | chunks=${conn.chunksReceived} | bytes=${conn.bytesReceived} | durationMs=${duration} | code=${code}`,
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

    const { meetingId, participant } = connection;
    if (connection.chunksReceived === 1) {
      const bytesPerSec =
        connection.sampleRate * connection.channels * 2; // s16le
      this.logger.log(
        `First audio chunk | meetingId=${meetingId} | participant=${participant} | bytes=${chunkSize} | sampleRate=${connection.sampleRate} | channels=${connection.channels} | s16leBytesPerSec=${bytesPerSec}`,
      );
      connection.lastIngressLogAt = now.getTime();
    } else {
      const periodMs = 5_000;
      const t = now.getTime();
      if (t - connection.lastIngressLogAt >= periodMs) {
        connection.lastIngressLogAt = t;
        this.logger.log(
          `Audio ingress | meetingId=${meetingId} | chunks=${connection.chunksReceived} | bytes=${connection.bytesReceived} | lastChunk=${chunkSize}b`,
        );
      }
    }

    // Enviar para o pipeline de processamento de áudio
    const meta: AudioChunkMeta = {
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
        meetingId: conn.meetingId,
        participant: conn.participant,
        bytesReceived: conn.bytesReceived,
        chunksReceived: conn.chunksReceived,
        duration: now - conn.connectedAt.getTime(),
      })),
    };
  }
}
