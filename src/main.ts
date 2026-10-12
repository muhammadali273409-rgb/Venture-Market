import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppConfiguration } from './config/configuration';
import { SocketIoAdapter } from './common/adapters/socket-io.adapter';

/** `{ "profile.firstName": "firstName must be shorter than..." }` — first failed constraint per field. */
function flattenValidationErrors(errors: ValidationError[], parent = ''): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const first = error.constraints ? Object.values(error.constraints)[0] : undefined;
    if (first) fields[path] = first;
    if (error.children?.length)
      Object.assign(fields, flattenValidationErrors(error.children, path));
  }
  return fields;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  const configService = app.get(ConfigService<AppConfiguration, true>);
  app.useLogger(app.get(Logger));

  // Render (like Heroku/Railway) terminates TLS and proxies over HTTP to a
  // single upstream hop. Without this, req.ip resolves to the proxy's
  // address for every request, which both corrupts audit-log IPs and
  // collapses per-IP rate limiting (ThrottlerGuard) into one shared bucket
  // for all users.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cookieParser(configService.get('auth', { infer: true }).cookieSecret));

  const frontendUrl = configService.get('frontendUrl', { infer: true });

  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });

  app.useWebSocketAdapter(new SocketIoAdapter(app, frontendUrl));

  // `/live` stays at the root so the Render health check path doesn't depend on API_PREFIX.
  app.setGlobalPrefix(configService.get('apiPrefix', { infer: true }), { exclude: ['live'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
      // Same 400 body as Nest's default (`message: string[]`), plus `fields`
      // keyed by property so clients can show each error under its input.
      exceptionFactory: (errors) => {
        const fields = flattenValidationErrors(errors);
        return new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          message: Object.values(fields),
          fields,
        });
      },
    }),
  );

  const swaggerEnabled =
    configService.get('nodeEnv', { infer: true }) !== 'production' ||
    configService.get('enableSwagger', { infer: true });

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('VentureMarket API')
      .setDescription('Marketplace for buying and selling startups — REST API')
      .setVersion('1.0')
      .addBearerAuth()
      .addCookieAuth('access_token')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  const port = configService.get('port', { infer: true });
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`VentureMarket backend listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
