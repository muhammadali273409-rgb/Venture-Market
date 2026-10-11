import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeValue } from '../constants/error-codes';

export class AppException extends HttpException {
  /** `details` is optional machine-readable context (e.g. the missing fields). */
  constructor(
    code: ErrorCodeValue,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: unknown,
  ) {
    super({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
  }
}

export class NotFoundAppException extends AppException {
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message, HttpStatus.NOT_FOUND);
  }
}

export class ForbiddenAppException extends AppException {
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message, HttpStatus.FORBIDDEN);
  }
}

export class ConflictAppException extends AppException {
  constructor(code: ErrorCodeValue, message: string, details?: unknown) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

export class UnauthorizedAppException extends AppException {
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message, HttpStatus.UNAUTHORIZED);
  }
}

export class PaymentRequiredAppException extends AppException {
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message, HttpStatus.PAYMENT_REQUIRED);
  }
}
