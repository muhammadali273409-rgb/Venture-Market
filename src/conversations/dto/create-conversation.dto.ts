import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MESSAGE_MAX_LENGTH, trimString } from './send-message.dto';

/**
 * Legacy/general form. For an enquiry about a listing prefer
 * POST /businesses/:businessId/conversations, where the seller is taken from
 * the business record instead of the request.
 */
export class CreateConversationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsUUID('4', { each: true })
  participantIds!: string[];

  @IsOptional()
  @IsUUID()
  businessId?: string;

  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_MAX_LENGTH)
  initialMessage!: string;
}
