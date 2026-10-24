import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkPaidDto {
  /** Bank transfer number / receipt reference the admin can match against. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}
