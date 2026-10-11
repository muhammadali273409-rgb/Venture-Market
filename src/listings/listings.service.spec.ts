import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListingsService } from './listings.service';
import { SearchListingsDto } from './dto/search-listings.dto';

/** Mirrors the global ValidationPipe (transform + whitelist + forbidNonWhitelisted). */
async function validateQuery(query: Record<string, unknown>) {
  const dto = plainToInstance(SearchListingsDto, query, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors: errors.map((e) => e.property) };
}

function setup(rows: unknown[] = [], total = rows.length) {
  const prisma = {
    business: {
      count: jest.fn(() => ({ op: 'count' })),
      findMany: jest.fn(() => ({ op: 'findMany' })),
    },
    $transaction: jest.fn(async () => [total, rows]),
  };
  const storage = { getSignedDownloadUrl: jest.fn(async (key: string) => `https://signed/${key}`) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ListingsService(prisma as any, storage as any);
  return { service, prisma };
}

describe('SearchListingsDto validation', () => {
  it('accepts a full, valid marketplace query and converts numbers', async () => {
    const { dto, errors } = await validateQuery({
      q: '  ai analytics ',
      category: 'saas-ai',
      minPrice: '1000',
      maxPrice: '100000',
      minRevenue: '1000',
      maxRevenue: '50000',
      minProfit: '0',
      maxProfit: '20000',
      businessModel: 'SaaS',
      verified: 'true',
      sortBy: 'revenue',
      sortDir: 'desc',
      page: '2',
      limit: '12',
    });
    expect(errors).toEqual([]);
    expect(dto.q).toBe('ai analytics');
    expect(dto.minPrice).toBe(1000);
    expect(dto.page).toBe(2);
  });

  it.each([
    ['negative price', { minPrice: '-5' }, 'minPrice'],
    ['non-numeric revenue', { minRevenue: 'lots' }, 'minRevenue'],
    ['fractional profit', { maxProfit: '10.5' }, 'maxProfit'],
    ['absurd price', { maxPrice: '1e15' }, 'maxPrice'],
    ['unknown sort field', { sortBy: 'ownerId' }, 'sortBy'],
    ['SQL in sort direction', { sortDir: 'desc; DROP TABLE users' }, 'sortDir'],
    ['page 0', { page: '0' }, 'page'],
    ['oversized page size', { limit: '1000' }, 'limit'],
    ['non-slug category', { category: "saas' OR 1=1" }, 'category'],
    ['non-uuid categoryId', { categoryId: 'SaaS' }, 'categoryId'],
    ['3-letter country', { country: 'USA' }, 'country'],
    ['non-boolean verified', { verified: 'yes' }, 'verified'],
    ['overlong search', { q: 'x'.repeat(101) }, 'q'],
    ['unknown parameter', { ownerEmail: 'a@b.c' }, 'ownerEmail'],
  ])('rejects %s', async (_label, query, property) => {
    const { errors } = await validateQuery(query);
    expect(errors).toContain(property);
  });
});

describe('ListingsService.buildWhere', () => {
  const { service } = setup();

  it('only ever matches live, public listings of active sellers', () => {
    const where = service.buildWhere({});
    expect(where).toMatchObject({
      deletedAt: null,
      status: 'PUBLISHED',
      listing: { status: 'PUBLISHED', visibility: 'PUBLIC' },
      owner: { deletedAt: null, status: { notIn: ['SUSPENDED', 'DEACTIVATED'] } },
    });
  });

  it('filters by category slug, or by id when one is given', () => {
    expect(service.buildWhere({ category: 'saas-ai' }).category).toEqual({ slug: 'saas-ai' });
    const byId = service.buildWhere({
      categoryId: 'c0a80101-0000-4000-8000-000000000001',
      category: 'x',
    });
    expect(byId.categoryId).toBe('c0a80101-0000-4000-8000-000000000001');
    expect(byId.category).toBeUndefined();
  });

  it('maps price, monthly revenue and monthly profit ranges to minor units on the listing', () => {
    const where = service.buildWhere({
      minPrice: 1000,
      maxPrice: 2000,
      minRevenue: 300,
      maxProfit: 150,
    });
    expect(where.listing).toEqual({
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      askingPriceMinor: { gte: 100_000n, lte: 200_000n },
      monthlyRevenueMinor: { gte: 30_000n },
      monthlyProfitMinor: { lte: 15_000n },
    });
  });

  it('treats the legacy minMrr as minRevenue', () => {
    const where = service.buildWhere({ minMrr: 50 });
    expect(where.listing).toMatchObject({ monthlyRevenueMinor: { gte: 5_000n } });
  });

  it.each([
    [{ minPrice: 10, maxPrice: 5 }],
    [{ minRevenue: 10, maxRevenue: 5 }],
    [{ minProfit: 10, maxProfit: 5 }],
  ])('rejects an inverted range %o', (query) => {
    let thrown: unknown;
    try {
      service.buildWhere(query);
    } catch (error) {
      thrown = error;
    }
    // AppException keeps the human message under response.error.message.
    expect(thrown).toMatchObject({
      status: 400,
      response: {
        error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/less than or equal/) },
      },
    });
  });

  it('requires every search word to match some public field, case-insensitively', () => {
    const where = service.buildWhere({ q: 'ai  analytics' });
    expect(where.AND).toHaveLength(2);
    expect((where.AND as Array<{ OR: unknown[] }>)[0].OR).toContainEqual({
      name: { contains: 'ai', mode: 'insensitive' },
    });
  });

  it('verified=true requires a VERIFIED verification; false is ignored', () => {
    expect(service.buildWhere({ verified: 'true' }).verifications).toEqual({
      some: { status: 'VERIFIED' },
    });
    expect(service.buildWhere({ verified: 'false' }).verifications).toBeUndefined();
  });
});

describe('ListingsService.buildOrderBy', () => {
  const { service } = setup();

  it.each([
    ['price', 'askingPriceMinor'],
    ['revenue', 'monthlyRevenueMinor'],
    ['mrr', 'monthlyRevenueMinor'],
    ['profit', 'monthlyProfitMinor'],
  ] as const)('sorts %s on %s with nulls last and an id tie-breaker', (sortBy, field) => {
    expect(service.buildOrderBy(sortBy, 'asc')).toEqual([
      { listing: { [field]: { sort: 'asc', nulls: 'last' } } },
      { id: 'asc' },
    ]);
  });

  it('defaults to recently listed (publishedAt)', () => {
    const [first, , last] = service.buildOrderBy(undefined, 'desc');
    expect(first).toEqual({ listing: { publishedAt: { sort: 'desc', nulls: 'last' } } });
    expect(last).toEqual({ id: 'asc' });
  });
});

describe('ListingsService.search', () => {
  const row = {
    id: 'biz-1',
    slug: 'acme',
    name: 'Acme',
    description: 'd'.repeat(300),
    categoryId: 'cat-1',
    category: { name: 'SaaS & AI', slug: 'saas-ai' },
    country: 'US',
    city: null,
    businessModel: 'SaaS',
    listing: {
      headline: null,
      askingPriceMinor: 1_000_000n,
      currency: 'USD',
      publishedAt: new Date('2026-10-01'),
      monthlyRevenueMinor: 500_000n,
      monthlyRevenueVerified: false,
      monthlyProfitMinor: null,
      monthlyProfitVerified: false,
    },
    owner: { id: 'seller-1', createdAt: new Date(), profile: { firstName: 'Sam', lastName: null } },
    images: [],
    metrics: [],
    verifications: [{ type: 'REVENUE', status: 'PENDING' }],
  };

  it('returns page metadata computed from the filtered total', async () => {
    const { service, prisma } = setup([row], 25);
    const result = await service.search({ page: 2, limit: 12 });
    expect(result.pagination).toEqual({
      page: 2,
      limit: 12,
      total: 25,
      totalPages: 3,
      hasMore: true,
    });
    expect(prisma.business.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 12, take: 12 }),
    );
  });

  it('serializes real figures only: missing profit stays null, nothing is marked verified', async () => {
    const { service } = setup([row]);
    const { data } = await service.search({});
    expect(data[0]).toMatchObject({
      askingPrice: 10_000,
      monthlyRevenue: 5_000,
      monthlyRevenueVerified: false,
      monthlyProfit: null,
      verified: false,
      categorySlug: 'saas-ai',
      seller: { id: 'seller-1', name: 'Sam' },
    });
    expect(data[0].excerpt).toHaveLength(221);
    expect(data[0]).not.toHaveProperty('images');
  });
});
