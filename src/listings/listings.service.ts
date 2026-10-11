import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../common/constants/error-codes';
import { AppException, NotFoundAppException } from '../common/errors/app.exception';
import { toMinorUnits, toMajorUnits } from '../common/utils/money';
import { ORDERED_IMAGES, pickCardMedia, serializeImages } from '../businesses/business-media';
import { DEFAULT_PAGE_SIZE, SearchListingsDto, SortableField } from './dto/search-listings.dto';

/**
 * A listing is only public while its seller's account is usable: a
 * soft-deleted, suspended or deactivated seller's projects drop off the
 * marketplace without touching the projects themselves.
 */
export const ACTIVE_OWNER: Prisma.UserWhereInput = {
  deletedAt: null,
  status: { notIn: ['SUSPENDED', 'DEACTIVATED'] },
};

/**
 * Shown in marketplace search and on seller profiles: live, PUBLIC listings
 * only. Drafts, paused, sold, suspended and deleted businesses never match.
 */
export const PUBLICLY_LISTED: Prisma.BusinessWhereInput = {
  deletedAt: null,
  status: 'PUBLISHED',
  listing: { status: 'PUBLISHED', visibility: 'PUBLIC' },
  owner: ACTIVE_OWNER,
};

/**
 * Reachable by direct link (detail page, contacting the seller): live
 * PUBLIC or UNLISTED (link-only) listings.
 */
export const PUBLICLY_REACHABLE: Prisma.BusinessWhereInput = {
  ...PUBLICLY_LISTED,
  listing: { status: 'PUBLISHED', visibility: { in: ['PUBLIC', 'UNLISTED'] } },
};

/** Public seller fields only — never email, phone or other account data. */
const SELLER_SELECT = {
  id: true,
  createdAt: true,
  profile: { select: { firstName: true, lastName: true, company: true, avatarUrl: true } },
} satisfies Prisma.UserSelect;

/** Seller-disclosed metrics, newest period last (the order the frontend reads them in). */
const PUBLIC_METRICS = {
  orderBy: { period: 'asc' as const },
  select: {
    id: true,
    businessId: true,
    metricType: true,
    valueMinor: true,
    currency: true,
    period: true,
    verificationStatus: true,
  },
} satisfies Prisma.Business$metricsArgs;

const LISTING_INCLUDE = {
  listing: true,
  category: true,
  owner: { select: SELLER_SELECT },
  images: ORDERED_IMAGES,
  metrics: PUBLIC_METRICS,
  verifications: { select: { type: true, status: true } },
} satisfies Prisma.BusinessInclude;

const EXCERPT_LENGTH = 220;

type RangeKey = 'Price' | 'Revenue' | 'Profit';

@Injectable()
export class ListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async search(query: SearchListingsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const where = this.buildWhere(query);
    const orderBy = this.buildOrderBy(query.sortBy, query.sortDir ?? 'desc');

    const [total, businesses] = await this.prisma.$transaction([
      this.prisma.business.count({ where }),
      this.prisma.business.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: LISTING_INCLUDE,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      data: await Promise.all(
        businesses.map(async (b) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { images, ...summary } = await this.toPublicSummary(b);
          return summary;
        }),
      ),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    };
  }

  /**
   * The business models that currently have public listings, for the
   * marketplace's business-model filter. Values are free text entered by
   * sellers, so case variants ("SaaS" / "saas") are merged.
   */
  async facets() {
    const rows = await this.prisma.business.groupBy({
      by: ['businessModel'],
      where: { ...PUBLICLY_LISTED, businessModel: { not: null } },
      _count: { _all: true },
    });

    const merged = new Map<string, { value: string; count: number; best: number }>();
    for (const row of rows) {
      const value = row.businessModel?.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { value, count: row._count._all, best: row._count._all });
      } else {
        current.count += row._count._all;
        // Keep the spelling most sellers used.
        if (row._count._all > current.best) {
          current.value = value;
          current.best = row._count._all;
        }
      }
    }

    return {
      businessModels: [...merged.values()]
        .map(({ value, count }) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    };
  }

  /**
   * Public detail. PUBLIC and UNLISTED (link-only) listings are reachable by
   * id or slug; drafts, paused, sold, suspended and deleted ones are a 404
   * for everyone — the seller previews their own through /businesses/:id.
   */
  async getPublicDetail(idOrSlug: string) {
    const business = await this.prisma.business.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], ...PUBLICLY_REACHABLE },
      include: LISTING_INCLUDE,
    });

    if (!business) {
      throw new NotFoundAppException(ErrorCode.LISTING_NOT_FOUND, 'Listing not found');
    }

    return this.toPublicDetail(business);
  }

  /**
   * Public seller profile. Only users who currently have at least one public
   * listing have one — so this can't be used to probe arbitrary accounts —
   * and it exposes exactly what listings already show about the seller.
   */
  async getPublicSeller(id: string) {
    const seller = await this.prisma.user.findFirst({
      where: { id, ...ACTIVE_OWNER, businesses: { some: PUBLICLY_LISTED } },
      select: {
        ...SELLER_SELECT,
        _count: { select: { businesses: { where: PUBLICLY_LISTED } } },
      },
    });
    if (!seller) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Seller not found');
    }
    return { ...this.toSeller(seller), publicListings: seller._count.businesses };
  }

  buildWhere(query: SearchListingsDto): Prisma.BusinessWhereInput {
    this.assertRange('Price', query.minPrice, query.maxPrice);
    const minRevenue = query.minRevenue ?? query.minMrr;
    this.assertRange('Revenue', minRevenue, query.maxRevenue);
    this.assertRange('Profit', query.minProfit, query.maxProfit);

    const listingWhere: Prisma.BusinessListingWhereInput = {
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
    };
    const price = moneyRange(query.minPrice, query.maxPrice);
    if (price) listingWhere.askingPriceMinor = price;
    const revenue = moneyRange(minRevenue, query.maxRevenue);
    if (revenue) listingWhere.monthlyRevenueMinor = revenue;
    const profit = moneyRange(query.minProfit, query.maxProfit);
    if (profit) listingWhere.monthlyProfitMinor = profit;

    const where: Prisma.BusinessWhereInput = { ...PUBLICLY_LISTED, listing: listingWhere };

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    } else if (query.category) {
      where.category = { slug: query.category };
    }
    if (query.businessModel) {
      where.businessModel = { equals: query.businessModel, mode: 'insensitive' };
    }
    if (query.country) {
      where.country = { equals: query.country, mode: 'insensitive' };
    }
    if (query.city) {
      where.city = { equals: query.city, mode: 'insensitive' };
    }
    if (query.sellerId) {
      where.ownerId = query.sellerId;
    }
    if (query.verified === 'true') {
      where.verifications = { some: { status: 'VERIFIED' } };
    }

    const term = query.q?.trim();
    if (term) {
      // Every word has to match somewhere, so "saas analytics" narrows results.
      where.AND = term
        .split(/\s+/)
        .slice(0, 8)
        .map((word) => ({
          OR: [
            { name: { contains: word, mode: 'insensitive' } },
            { description: { contains: word, mode: 'insensitive' } },
            { businessModel: { contains: word, mode: 'insensitive' } },
            { city: { contains: word, mode: 'insensitive' } },
            { listing: { headline: { contains: word, mode: 'insensitive' } } },
            { category: { name: { contains: word, mode: 'insensitive' } } },
          ],
        }));
    }

    return where;
  }

  /**
   * Always ends in a unique key (id) so the order — and therefore every
   * page — is stable when many listings share a price or have none.
   * Listings without the sorted figure go last in both directions.
   */
  buildOrderBy(
    sortBy: SortableField | undefined,
    dir: 'asc' | 'desc',
  ): Prisma.BusinessOrderByWithRelationInput[] {
    const nullsLast = { sort: dir, nulls: 'last' as const };
    switch (sortBy) {
      case 'price':
        return [{ listing: { askingPriceMinor: nullsLast } }, { id: 'asc' }];
      case 'revenue':
      case 'mrr':
        return [{ listing: { monthlyRevenueMinor: nullsLast } }, { id: 'asc' }];
      case 'profit':
        return [{ listing: { monthlyProfitMinor: nullsLast } }, { id: 'asc' }];
      case 'createdAt':
      default:
        // "Recently listed" = when it went live, not when the draft was started.
        return [{ listing: { publishedAt: nullsLast } }, { createdAt: dir }, { id: 'asc' }];
    }
  }

  private assertRange(name: RangeKey, min: number | undefined, max: number | undefined): void {
    if (min !== undefined && max !== undefined && min > max) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `min${name} must be less than or equal to max${name}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toSeller(owner: any) {
    const profile = owner?.profile;
    const name = [profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || null;
    return {
      id: owner.id,
      name,
      company: profile?.company ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      memberSince: owner.createdAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async toPublicSummary(business: any) {
    const images = await serializeImages(this.storageService, business.images);
    const listing = business.listing;
    const description: string | null = business.description ?? null;
    return {
      id: business.id,
      slug: business.slug,
      name: business.name,
      headline: listing?.headline ?? null,
      excerpt:
        description && description.length > EXCERPT_LENGTH
          ? `${description.slice(0, EXCERPT_LENGTH).trimEnd()}…`
          : description,
      category: business.category?.name ?? null,
      categoryId: business.categoryId ?? null,
      categorySlug: business.category?.slug ?? null,
      country: business.country,
      city: business.city ?? null,
      businessModel: business.businessModel ?? null,
      askingPrice: majorOrNull(listing?.askingPriceMinor),
      currency: listing?.currency ?? 'USD',
      // Latest monthly figures as disclosed by the seller; null = not disclosed.
      monthlyRevenue: majorOrNull(listing?.monthlyRevenueMinor),
      monthlyRevenueVerified: Boolean(listing?.monthlyRevenueVerified),
      monthlyProfit: majorOrNull(listing?.monthlyProfitMinor),
      monthlyProfitVerified: Boolean(listing?.monthlyProfitVerified),
      verified: (business.verifications ?? []).some(
        (v: { status: string }) => v.status === 'VERIFIED',
      ),
      publishedAt: listing?.publishedAt ?? null,
      ...pickCardMedia(images),
      seller: this.toSeller(business.owner),
      metrics: (business.metrics ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ valueMinor, ...metric }: any) => ({ ...metric, value: toMajorUnits(valueMinor) }),
      ),
      images,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async toPublicDetail(business: any) {
    return {
      ...(await this.toPublicSummary(business)),
      ownerId: business.ownerId,
      description: business.description,
      foundedAt: business.foundedAt,
      website: business.website,
      verifications: business.verifications.map((v: { type: string; status: string }) => ({
        type: v.type,
        status: v.status,
      })),
    };
  }
}

function moneyRange(min: number | undefined, max: number | undefined) {
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { gte: toMinorUnits(min) } : {}),
    ...(max !== undefined ? { lte: toMinorUnits(max) } : {}),
  };
}

function majorOrNull(minor: bigint | null | undefined): number | null {
  return minor == null ? null : toMajorUnits(minor);
}
