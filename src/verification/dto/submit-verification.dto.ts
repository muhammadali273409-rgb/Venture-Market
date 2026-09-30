import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { VerificationType } from '@prisma/client';

const TYPES: VerificationType[] = [
  'IDENTITY',
  'BUSINESS',
  'OWNERSHIP',
  'REVENUE',
  'TRAFFIC',
  'FINANCIAL',
  'DOMAIN',
  'ANALYTICS',
  'CUSTOMERS',
];

class VerificationItemInput {
  @IsString()
  label!: string;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  documentId?: string;
}

export class SubmitVerificationDto {
  @IsIn(TYPES)
  type!: VerificationType;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VerificationItemInput)
  items?: VerificationItemInput[];
}
