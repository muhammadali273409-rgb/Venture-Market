import { IsOptional, IsString, IsUrl, IsUUID, Matches } from 'class-validator';

/** A version is either an uploaded deal document (PDF) or an external link. */
export class CreateAgreementVersionDto {
  @IsOptional()
  @IsUrl({ protocols: ['https', 'http'], require_tld: false })
  contentUrl?: string;

  /** SHA-256 of the file, hex — lets both parties prove which file they signed. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'contentHash must be a hex SHA-256 digest' })
  contentHash?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;
}
