import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateBusinessDto } from './create-business.dto';

/**
 * Listing fields (price, headline) are edited through PATCH /businesses/:id/listing
 * and revenue through POST /businesses/:id/metrics, so they're not accepted here.
 */
export class UpdateBusinessDto extends PartialType(
  OmitType(CreateBusinessDto, ['headline', 'askingPrice', 'currency', 'annualRevenue'] as const),
) {}
