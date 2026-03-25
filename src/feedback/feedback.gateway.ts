// Use console.* for tracing so logs are visible even when Nest logger is disabled.
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { Prisma } from '@prisma/client';
import type { FeedbackSeverity, FeedbackType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({
  // origin: '*' with credentials: true is invalid for browsers; use reflected origin (same as main.ts enableCors).
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket'],
})
export class FeedbackGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(private readonly prisma: PrismaService) {}

  @WebSocketServer()
  server: Server;

  private readonly rooms = new Map<string, Set<string>>(); // room -> Set<socketId>

  handleConnection(client: Socket) {
    console.log(`[FeedbackGateway] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[FeedbackGateway] Client disconnected: ${client.id}`);
    // Remove client from all rooms
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
    @ConnectedSocket() client: Socket,
    @MessageBody() room: string,
  ) {
    if (typeof room !== 'string' || !room.trim()) {
      console.warn(`Invalid room name from client ${client.id}`);
      return;
    }

    const roomName = room.trim();

    // Leave all other rooms this client might be in
    for (const [existingRoom, clients] of this.rooms.entries()) {
      if (clients.has(client.id)) {
        client.leave(existingRoom);
        clients.delete(client.id);
        if (clients.size === 0) {
          this.rooms.delete(existingRoom);
        }
      }
    }

    // Join new room
    client.join(roomName);
    if (!this.rooms.has(roomName)) {
      this.rooms.set(roomName, new Set());
    }
    this.rooms.get(roomName)?.add(client.id);

    console.log(`Client ${client.id} joined room ${roomName}`);

    const feedbackRoomPrefix = 'feedback:';
    const meetingId = roomName.startsWith(feedbackRoomPrefix)
      ? roomName.slice(feedbackRoomPrefix.length).trim()
      : '';

    let recent: Array<Record<string, unknown>> = [];
    if (meetingId) {
      try {
        recent = await this.loadRecentFeedback(meetingId);
      } catch (error) {
        console.error(
          `[FeedbackGateway] failed to load recent feedback for room=${roomName} meetingId=${meetingId}`,
          error,
        );
      }
    }

    client.emit('room-joined', {
      room: roomName,
      meetingId: meetingId || undefined,
      recent,
    });

    console.log(
      `[FeedbackGateway] room-joined ack client=${client.id} room=${roomName} recent=${recent.length}`,
    );
  }

  // Method to broadcast feedback to a room (can be called from services)
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
    meetingId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = await (
      this.prisma as unknown as {
        feedbackEvent: {
          findMany: (args: {
            where: { meetingId: string };
            orderBy: { createdAt: 'desc' };
            take: number;
            select: {
              id: true;
              meetingId: true;
              participantId: true;
              type: true;
              severity: true;
              ts: true;
              createdAt: true;
              windowStart: true;
              windowEnd: true;
              message: true;
              metadata: true;
            };
          }) => Promise<
            Array<{
              id: string;
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
      where: { meetingId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
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
