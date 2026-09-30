import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorCode } from '../constants/error-codes';

interface NormalizedError {
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { id?: string }).id;

    const { status, error } = this.normalize(exception);

    this.logger.error(
      `${request.method} ${request.url} -> ${status} ${error.code}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // `statusCode`/`message` mirror Nest's default error shape so clients that
    // read them (e.g. `message: ["website must be a URL"]`) get the real
    // validation errors; `error` keeps the structured code for existing clients.
    response.status(status).json({
      statusCode: status,
      message: Array.isArray(error.details) ? error.details : error.message,
      error,
      requestId,
    });
  }

  private normalize(exception: unknown): { status: number; error: NormalizedError } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // AppException bodies carry a structured `{ error: { code, message } }`.
      // Nest's built-in exceptions also have an `error` key, but it's just the
      // status text ("Bad Request"), so only accept an object here.
      if (
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as { error: unknown }).error === 'object' &&
        (body as { error: unknown }).error !== null
      ) {
        return { status, error: (body as { error: NormalizedError }).error };
      }

      if (typeof body === 'object' && body !== null && 'message' in body) {
        const message = (body as { message: string | string[] }).message;
        return {
          status,
          error: {
            code:
              status === HttpStatus.BAD_REQUEST
                ? ErrorCode.VALIDATION_ERROR
                : ErrorCode.INTERNAL_ERROR,
            message: Array.isArray(message) ? message.join('; ') : message,
            details: Array.isArray(message) ? message : undefined,
          },
        };
      }

      return {
        status,
        error: { code: ErrorCode.INTERNAL_ERROR, message: exception.message },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    };
  }
}
