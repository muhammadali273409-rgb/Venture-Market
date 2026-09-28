import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeValue } from '../constants/error-codes';

export class AppException extends HttpException {
  constructor(code: ErrorCodeValue, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ error: { code, message } }, status);
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
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message, HttpStatus.CONFLICT);
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
