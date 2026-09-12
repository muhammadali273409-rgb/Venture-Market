import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AppConfiguration } from '../config/configuration';
import { JwtPayload } from '../auth/strategies/jwt.strategy';

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
  ) {}

  handleConnection(client: Socket): void {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('Missing token');
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get('auth', { infer: true }).jwtSecret,
      });
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
}
