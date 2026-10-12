import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { ErrorCode } from '../constants/error-codes';

interface NormalizedError {
  code: string;
  message: string;
  details?: unknown;
  /** Validation / uniqueness failures keyed by request field, e.g. `{ email: "..." }`. */
  fields?: Record<string, string>;
}

// Prisma codes meaning "couldn't talk to the database" (unreachable, timed out,
// connection closed, pool exhausted) — the request itself was fine.
const PRISMA_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
// Table/column missing: the deployed schema is behind the code (migrations not applied).
const PRISMA_SCHEMA_DRIFT_CODES = new Set(['P2021', 'P2022']);

const STATUS_CODES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTH_UNAUTHORIZED,
  [HttpStatus.PAYMENT_REQUIRED]: ErrorCode.BILLING_PAYMENT_REQUIRED,
  [HttpStatus.FORBIDDEN]: ErrorCode.AUTH_FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.INTERNAL_SERVER_ERROR]: ErrorCode.INTERNAL_ERROR,
};

// Fallback code for exceptions that don't carry their own: the app's code for
// the status if it has one, otherwise the HttpStatus name (e.g. METHOD_NOT_ALLOWED,
// PAYLOAD_TOO_LARGE, SERVICE_UNAVAILABLE).
function codeForStatus(status: number): string {
  return (
    STATUS_CODES[status] ??
    (HttpStatus[status] as string | undefined) ??
    (status >= 500 ? ErrorCode.INTERNAL_ERROR : 'HTTP_ERROR')
  );
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

    const summary = `${request.method} ${request.url} -> ${status} ${error.code}`;
    if (status >= 500) {
      this.logger.error(summary, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn(summary);
    }

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
      // Terminus also puts an object under `error` (per-indicator results), so
      // require a string `code` before trusting it as an AppException body.
      const nested = (body as { error?: unknown } | null)?.error;
      if (
        typeof nested === 'object' &&
        nested !== null &&
        typeof (nested as { code?: unknown }).code === 'string'
      ) {
        return { status, error: nested as NormalizedError };
      }

      const code = codeForStatus(status);

      if (typeof body === 'object' && body !== null && 'message' in body) {
        const { message, fields } = body as {
          message: string | string[];
          fields?: Record<string, string>;
        };
        return {
          status,
          error: {
            code,
            message: Array.isArray(message) ? message.join('; ') : message,
            details: Array.isArray(message) ? message : undefined,
            ...(fields ? { fields } : {}),
          },
        };
      }

      return { status, error: { code, message: exception.message } };
    }

    const prismaError = this.normalizePrisma(exception);
    if (prismaError) return prismaError;

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    };
  }

  /**
   * Maps the Prisma errors that are *not* server bugs to proper statuses.
   * Anything else (including schema drift) stays a 500.
   */
  private normalizePrisma(exception: unknown): { status: number; error: NormalizedError } | null {
    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      (exception instanceof Prisma.PrismaClientKnownRequestError &&
        PRISMA_UNAVAILABLE_CODES.has(exception.code))
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        error: {
          code: ErrorCode.DATABASE_UNAVAILABLE,
          message: 'The database is unavailable. Please try again shortly.',
        },
      };
    }

    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) return null;

    // Unique constraint — e.g. two concurrent sign-ups with the same email
    // both passing the service's pre-check.
    if (exception.code === 'P2002') {
      const target = exception.meta?.target;
      const fields = Array.isArray(target)
        ? target.map(String)
        : typeof target === 'string'
          ? [target]
          : [];
      const isEmail = fields.includes('email');
      const message = isEmail
        ? 'An account with this email already exists'
        : 'This value is already taken';
      return {
        status: HttpStatus.CONFLICT,
        error: {
          code: isEmail ? ErrorCode.AUTH_EMAIL_TAKEN : ErrorCode.CONFLICT,
          message,
          ...(fields.length > 0
            ? { fields: Object.fromEntries(fields.map((f) => [f, message])) }
            : {}),
        },
      };
    }

    if (PRISMA_SCHEMA_DRIFT_CODES.has(exception.code)) {
      this.logger.error(
        `Database schema is behind the code (${exception.code}): run "prisma migrate deploy"`,
      );
    }
    return null;
  }
}
