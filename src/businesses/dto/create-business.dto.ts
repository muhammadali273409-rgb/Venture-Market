import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const LISTING_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

export class CreateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessModel?: string;

  @IsOptional()
  @IsISO8601()
  foundedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsUrl()
  website?: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  // ── Listing fields, so a project can be created complete in one request ──

  @IsOptional()
  @IsString()
  @MaxLength(200)
  headline?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  askingPrice?: number;

  @IsOptional()
  @IsIn(LISTING_CURRENCIES)
  @Length(3, 3)
  currency?: string;

  /** Seller-reported annual revenue; stored as a REVENUE metric for the current year. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000_000)
  annualRevenue?: number;
}
