import { IsIn, IsOptional } from 'class-validator';
import { BusinessImageKind } from '@prisma/client';

export class UploadImageDto {
  @IsOptional()
  @IsIn(['LOGO', 'GALLERY'])
  kind?: BusinessImageKind;
}
