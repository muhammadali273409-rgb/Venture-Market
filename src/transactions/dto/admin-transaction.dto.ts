import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TransactionStatus } from '@prisma/client';

const STATUSES: TransactionStatus[] = [
  'PENDING',
  'PROCESSING',
  'REQUIRES_ACTION',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
];

export class ListAdminTransactionsQuery {
  @IsOptional()
  @IsIn(STATUSES)
  status?: TransactionStatus;
}

export class RejectPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
