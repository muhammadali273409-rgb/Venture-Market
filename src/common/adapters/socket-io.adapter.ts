import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

/**
 * Applies the same FRONTEND_URL-scoped CORS policy to the WebSocket server
 * that main.ts's app.enableCors() applies to the REST API. Configured here
 * (constructed after NestFactory.create, with ConfigService already
 * initialized) rather than via `@WebSocketGateway({ cors })`, because that
 * decorator evaluates at module-import time — before ConfigModule has
 * loaded FRONTEND_URL from a .env file in local dev.
 */
export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly frontendUrl: string,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.frontendUrl, credentials: true },
    });
  }
}
