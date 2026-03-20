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

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  transports: ['websocket'],
})
export class FeedbackGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
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
  handleJoinRoom(
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
}
