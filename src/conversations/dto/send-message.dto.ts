import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export const MESSAGE_MAX_LENGTH = 5000;

/** Trimmed first, so a whitespace-only message fails MinLength. */
export const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SendMessageDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(MESSAGE_MAX_LENGTH)
  body!: string;
}
