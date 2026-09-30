import { IsISO8601, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateOfferDto {
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  /** Proposed deal terms (structure, earn-out, transition period…). */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  terms?: string;

  /** Free-text note to the other party. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  /** When the offer lapses if not answered. Must be in the future. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
