import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AppConfiguration } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { SOCKET_TOKEN_TYPE, SocketTokenPayload } from '../auth/socket-token';

interface SocketData {
  userId: string;
  lastTypingAt: number;
}

/** A client sending "typing" more often than this is ignored. */
const TYPING_MIN_INTERVAL_MS = 1000;

// No `cors` option here on purpose: the actual Socket.IO server is created
// via the custom adapter registered in main.ts (SocketIoAdapter), which
// applies the same FRONTEND_URL-scoped CORS policy as the REST API's
// app.enableCors() — using ConfigService there instead of process.env here
// means it works correctly regardless of whether FRONTEND_URL comes from a
// real environment variable (Render) or a .env file loaded by ConfigModule
// (local dev), since decorator evaluation happens before ConfigModule runs.
@WebSocketGateway({
  namespace: 'realtime',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly prisma: PrismaService,
  ) {}

  handleConnection(client: Socket): void {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('Missing token');
      const payload = this.jwtService.verify<SocketTokenPayload>(token, {
        secret: this.configService.get('auth', { infer: true }).jwtSecret,
      });
      // Only tokens from GET /auth/socket-token — see socket-token.ts.
      if (payload.typ !== SOCKET_TOKEN_TYPE) throw new Error('Not a socket token');
      const data: SocketData = { userId: payload.sub, lastTypingAt: 0 };
      client.data = data;
      void client.join(`user:${payload.sub}`);
    } catch {
      this.logger.warn(`Rejected unauthenticated socket connection: ${client.id}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(): void {
    // no-op: room membership is cleaned up automatically by socket.io
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  emitToUsers(userIds: string[], event: string, payload: unknown): void {
    if (userIds.length === 0) return;
    this.server.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  }

  /** "X is typing…" — relayed to the conversation's other participants only. */
  @SubscribeMessage('conversation.typing')
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: unknown },
  ): Promise<void> {
    const data = client.data as SocketData | undefined;
    const conversationId = body?.conversationId;
    if (!data?.userId || typeof conversationId !== 'string') return;

    const now = Date.now();
    if (now - data.lastTypingAt < TYPING_MIN_INTERVAL_MS) return;
    data.lastTypingAt = now;

    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    if (!participants.some((p) => p.userId === data.userId)) return;

    const others = participants.map((p) => p.userId).filter((id) => id !== data.userId);
    this.emitToUsers(others, 'conversation.typing', { conversationId, userId: data.userId });
  }
}
