import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

interface FilterBody {
  message: unknown;
  error: { code: string; message: string; fields?: Record<string, string> };
}

function run(exception: unknown): { status: number; body: FilterBody } {
  const result = { status: 0, body: undefined as unknown as FilterBody };
  const response = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: FilterBody) {
      result.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/v1/auth/register', id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return result;
}

describe('HttpExceptionFilter', () => {
  it('maps a unique-constraint violation on email to 409 AUTH_EMAIL_TAKEN', () => {
    const error = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['email'] },
    });
    const { status, body } = run(error);
    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body.error.code).toBe('AUTH_EMAIL_TAKEN');
    expect(body.error.fields).toEqual({ email: expect.any(String) });
  });

  it('maps an unreachable database to 503 DATABASE_UNAVAILABLE', () => {
    const error = new Prisma.PrismaClientInitializationError("Can't reach database server", 'x');
    const { status, body } = run(error);
    expect(status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('keeps unknown errors as a generic 500', () => {
    const { status, body } = run(new Error('boom'));
    expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('passes per-field validation errors through as error.fields', () => {
    const exception = new BadRequestException({
      message: ['password must be longer than or equal to 10 characters'],
      fields: { password: 'password must be longer than or equal to 10 characters' },
    });
    const { status, body } = run(exception);
    expect(status).toBe(HttpStatus.BAD_REQUEST);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toEqual({
      password: 'password must be longer than or equal to 10 characters',
    });
    expect(body.message).toEqual(['password must be longer than or equal to 10 characters']);
  });
});

describe('HttpExceptionFilter status codes', () => {
  it('returns NOT_FOUND (not INTERNAL_ERROR) for an unknown route', () => {
    const { status, body } = run(new NotFoundException('Cannot GET /'));
    expect(status).toBe(HttpStatus.NOT_FOUND);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
