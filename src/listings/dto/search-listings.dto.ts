import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * `revenue` sorts on monthly revenue (latest MRR) and `profit` on monthly
 * profit (latest PROFIT). `mrr` is the older alias of `revenue`.
 */
export const SORTABLE_FIELDS = ['createdAt', 'price', 'revenue', 'profit', 'mrr'] as const;
export type SortableField = (typeof SORTABLE_FIELDS)[number];

/** Upper bound for any money filter (major units) — far above any real listing. */
const MAX_MONEY = 1_000_000_000_000;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE = 10_000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Optional, non-negative whole money amount in major units (e.g. dollars). */
function Money(): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Type(() => Number)(target, key);
    IsInt()(target, key);
    Min(0)(target, key);
    Max(MAX_MONEY)(target, key);
  };
}

export class SearchListingsDto {
  /** Free-text search over name, headline, description, business model, city and category. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Category slug — the shareable form used in marketplace URLs. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'category must be a category slug' })
  category?: string;

  /** Exact business model (case-insensitive), as listed by GET /listings/facets. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  businessModel?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  city?: string;

  /** Only this seller's listings (the seller profile view). */
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @Money() minPrice?: number;
  @Money() maxPrice?: number;

  /** Monthly revenue range (latest MRR metric). */
  @Money() minRevenue?: number;
  @Money() maxRevenue?: number;

  /** Monthly profit range (latest PROFIT metric). */
  @Money() minProfit?: number;
  @Money() maxProfit?: number;

  /** @deprecated alias of minRevenue, kept so existing links keep working. */
  @Money() minMrr?: number;

  /** "true" → only businesses with at least one VERIFIED verification. */
  @IsOptional()
  @IsIn(['true', 'false'])
  verified?: 'true' | 'false';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, { message: 'country must be a 2-letter country code' })
  country?: string;

  @IsOptional()
  @IsIn(SORTABLE_FIELDS)
  sortBy?: SortableField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
