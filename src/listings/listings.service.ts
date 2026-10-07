import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../common/constants/error-codes';
import { NotFoundAppException } from '../common/errors/app.exception';
import { buildCursorPage } from '../common/utils/cursor-pagination';
import { toMinorUnits, toMajorUnits } from '../common/utils/money';
import { ORDERED_IMAGES, pickCardMedia, serializeImages } from '../businesses/business-media';
import { SearchListingsDto } from './dto/search-listings.dto';

/**
 * A listing is only public while its seller's account is usable: a
 * soft-deleted, suspended or deactivated seller's projects drop off the
 * marketplace without touching the projects themselves.
 */
const ACTIVE_OWNER: Prisma.UserWhereInput = {
  deletedAt: null,
  status: { notIn: ['SUSPENDED', 'DEACTIVATED'] },
};

/** Public seller fields only — never email or other account data. */
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
} satisfies Prisma.BusinessInclude;

@Injectable()
export class ListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async search(query: SearchListingsDto) {
    const limit = query.limit ?? 20;

    const listingWhere: Prisma.BusinessListingWhereInput = {
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
    };

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      listingWhere.askingPriceMinor = {
        gte: query.minPrice !== undefined ? toMinorUnits(query.minPrice) : undefined,
        lte: query.maxPrice !== undefined ? toMinorUnits(query.maxPrice) : undefined,
      };
    }

    const where: Prisma.BusinessWhereInput = {
      deletedAt: null,
      status: 'PUBLISHED',
      listing: listingWhere,
      owner: ACTIVE_OWNER,
    };

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }
    if (query.country) {
      where.country = query.country;
    }
    if (query.city) {
      where.city = { equals: query.city, mode: 'insensitive' };
    }
    if (query.sellerId) {
      where.ownerId = query.sellerId;
    }
    if (query.minMrr !== undefined) {
      where.metrics = {
        some: { metricType: 'MRR', valueMinor: { gte: toMinorUnits(query.minMrr) } },
      };
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

    const orderBy = this.buildOrderBy(query.sortBy, query.sortDir ?? 'desc');

    const businesses = await this.prisma.business.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: LISTING_INCLUDE,
    });

    const page = buildCursorPage(businesses, limit);
    return {
      ...page,
      data: await Promise.all(
        page.data.map(async (b) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { images, ...summary } = await this.toPublicSummary(b);
          return summary;
        }),
      ),
    };
  }

  /**
   * Public detail. PUBLIC and UNLISTED (link-only) listings are reachable by
   * id or slug; drafts, paused, suspended and deleted ones are a 404 for
   * everyone — the seller previews their own through /businesses/:id.
   */
  async getPublicDetail(idOrSlug: string) {
    const business = await this.prisma.business.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
        deletedAt: null,
        status: 'PUBLISHED',
        listing: { status: 'PUBLISHED', visibility: { in: ['PUBLIC', 'UNLISTED'] } },
        owner: ACTIVE_OWNER,
      },
      include: { ...LISTING_INCLUDE, verifications: true },
    });

    if (!business) {
      throw new NotFoundAppException(ErrorCode.LISTING_NOT_FOUND, 'Listing not found');
    }

    return this.toPublicDetail(business);
  }

  private buildOrderBy(
    sortBy: string | undefined,
    dir: 'asc' | 'desc',
  ): Prisma.BusinessOrderByWithRelationInput {
    switch (sortBy) {
      case 'price':
        return { listing: { askingPriceMinor: dir } };
      case 'createdAt':
      default:
        return { createdAt: dir };
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
    return {
      id: business.id,
      slug: business.slug,
      name: business.name,
      headline: business.listing?.headline ?? null,
      category: business.category?.name ?? null,
      categoryId: business.categoryId ?? null,
      country: business.country,
      city: business.city ?? null,
      businessModel: business.businessModel ?? null,
      askingPrice: business.listing?.askingPriceMinor
        ? toMajorUnits(business.listing.askingPriceMinor)
        : null,
      currency: business.listing?.currency ?? 'USD',
      publishedAt: business.listing?.publishedAt ?? null,
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
