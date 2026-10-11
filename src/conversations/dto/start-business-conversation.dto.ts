import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MESSAGE_MAX_LENGTH, trimString } from './send-message.dto';

/**
 * Body of POST /businesses/:businessId/conversations. There is deliberately
 * no seller/participant field: the seller is always the business's owner.
 */
export class StartBusinessConversationDto {
  /** Optional first message; omitted → just open (or create) the thread. */
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_MAX_LENGTH)
  message?: string;
}
