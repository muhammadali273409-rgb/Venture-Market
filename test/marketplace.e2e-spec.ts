import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { nanoid } from 'nanoid';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { createTestApp } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { refreshListingFinancials } from '../src/businesses/listing-financials';

/**
 * Marketplace search/filters/sorting/pagination and buyer → seller chat,
 * end to end against a real database.
 *
 * Requires a live PostgreSQL + Redis reachable via DATABASE_URL / REDIS_URL —
 * point at a disposable test database or schema, never production. Every
 * record carries a per-run token, so runs don't see each other's data.
 */
describe('Marketplace & buyer-seller chat (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tok = nanoid(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x');
  const password = 'CorrectHorseBattery9!';
  const day = 24 * 60 * 60 * 1000;

  const users = {} as Record<
    'seller' | 'seller2' | 'buyer' | 'outsider',
    { id: string; cookies: string[] }
  >;
  const biz = {} as Record<string, string>;
  let catA: string;
  let catB: string;
  let conversationId: string;

  const http = () => request(app.getHttpServer());
  const search = (query: Record<string, string | number>) =>
    http().get('/api/v1/listings').query(query);
  const names = (res: request.Response) =>
    (res.body.data as Array<{ name: string }>).map((l) => l.name.replace(` ${tok}`, ''));

  beforeAll(async () => {
    app = await createTestApp();
    // This suite writes data — never let it touch a hosted database.
    if (!/@(localhost|127.0.0.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
      throw new Error('Refusing to run marketplace e2e against a non-local DATABASE_URL');
    }
    prisma = app.get(PrismaService);

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const roles: Record<keyof typeof users, UserRole> = {
      seller: 'SELLER',
      seller2: 'SELLER',
      buyer: 'BUYER',
      outsider: 'BUYER',
    };
    for (const [key, role] of Object.entries(roles) as [keyof typeof users, UserRole][]) {
      const email = `${key}-${tok}@example.com`;
      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          role,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          profile: { create: { firstName: key, lastName: 'E2E', company: `${key} Co` } },
        },
      });
      const res = await http().post('/api/v1/auth/login').send({ email, password }).expect(200);
      users[key] = { id: user.id, cookies: res.headers['set-cookie'] as unknown as string[] };
    }

    catA = `e2e-saas-${tok}`;
    catB = `e2e-media-${tok}`;
    const categoryA = await prisma.businessCategory.create({
      data: { name: `E2E SaaS ${tok}`, slug: catA },
    });
    const categoryB = await prisma.businessCategory.create({
      data: { name: `E2E Media ${tok}`, slug: catB },
    });

    // Alpha goes through the real seller API: create → metrics → publish.
    const created = await http()
      .post('/api/v1/businesses')
      .set('Cookie', users.seller.cookies)
      .send({
        name: `Alpha AI ${tok}`,
        description: 'Machine learning copywriting assistant',
        categoryId: categoryA.id,
        businessModel: 'SaaS',
        askingPrice: 10_000,
        currency: 'USD',
      })
      .expect(201);
    biz.alpha = created.body.data.id;
    for (const metric of [
      { metricType: 'MRR', value: 1_500, period: '2026-08-01' },
      { metricType: 'MRR', value: 2_000, period: '2026-09-01' },
      { metricType: 'PROFIT', value: 800, period: '2026-09-01' },
    ]) {
      await http()
        .post(`/api/v1/businesses/${biz.alpha}/metrics`)
        .set('Cookie', users.seller.cookies)
        .send(metric)
        .expect(201);
    }
    await http()
      .post(`/api/v1/businesses/${biz.alpha}/publish`)
      .set('Cookie', users.seller.cookies)
      .expect(201);
    await prisma.businessListing.update({
      where: { businessId: biz.alpha },
      data: { publishedAt: new Date(Date.now() - 1 * day) },
    });
    await prisma.businessVerification.create({
      data: { businessId: biz.alpha, type: 'REVENUE', status: 'VERIFIED' },
    });

    // The rest are inserted directly with controlled dates and states.
    const make = async (
      key: string,
      opts: {
        name: string;
        ownerId?: string;
        categoryId: string;
        businessModel: string;
        priceMinor: bigint;
        daysAgo: number;
        status?: 'PUBLISHED' | 'DRAFT' | 'SOLD';
        visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
        metrics?: Array<{
          metricType: 'MRR' | 'PROFIT' | 'REVENUE';
          valueMinor: bigint;
          verified?: boolean;
        }>;
      },
    ) => {
      const status = opts.status ?? 'PUBLISHED';
      const business = await prisma.business.create({
        data: {
          ownerId: opts.ownerId ?? users.seller.id,
          name: `${opts.name} ${tok}`,
          slug: `${opts.name.toLowerCase().replace(/\s+/g, '-')}-${tok}`,
          description: `${opts.name} test listing`,
          categoryId: opts.categoryId,
          businessModel: opts.businessModel,
          status,
          listing: {
            create: {
              status: status === 'PUBLISHED' ? 'PUBLISHED' : status === 'SOLD' ? 'SOLD' : 'DRAFT',
              visibility: opts.visibility ?? 'PUBLIC',
              askingPriceMinor: opts.priceMinor,
              publishedAt: new Date(Date.now() - opts.daysAgo * day),
            },
          },
          metrics: {
            create: (opts.metrics ?? []).map((m) => ({
              metricType: m.metricType,
              valueMinor: m.valueMinor,
              period: new Date('2026-09-01'),
              verificationStatus: m.verified ? ('VERIFIED' as const) : ('UNVERIFIED' as const),
            })),
          },
        },
      });
      await refreshListingFinancials(prisma, business.id);
      biz[key] = business.id;
    };

    await make('beta', {
      name: 'Beta Analytics',
      categoryId: categoryA.id,
      businessModel: 'SaaS',
      priceMinor: 5_000_000n,
      daysAgo: 2,
      metrics: [
        { metricType: 'MRR', valueMinor: 500_000n },
        { metricType: 'PROFIT', valueMinor: 100_000n, verified: true },
      ],
    });
    await make('gamma', {
      name: 'Gamma Newsletter',
      ownerId: users.seller2.id,
      categoryId: categoryB.id,
      businessModel: 'Newsletter',
      priceMinor: 2_000_000n,
      daysAgo: 3,
      // Annual revenue only — must NOT show up as monthly revenue.
      metrics: [
        { metricType: 'REVENUE', valueMinor: 6_000_000n },
        { metricType: 'PROFIT', valueMinor: 150_000n },
      ],
    });
    const hidden = {
      categoryId: categoryA.id,
      businessModel: 'SaaS',
      priceMinor: 100_000n,
      daysAgo: 0,
    };
    await make('draft', { ...hidden, name: 'Delta Draft', status: 'DRAFT' });
    await make('sold', { ...hidden, name: 'Epsilon Sold', status: 'SOLD' });
    await make('private', { ...hidden, name: 'Zeta Private', visibility: 'PRIVATE' });
    await make('unlisted', { ...hidden, name: 'Eta Unlisted', visibility: 'UNLISTED' });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('filters, search, sorting and pagination', () => {
    it('a category returns only its businesses', async () => {
      const a = await search({ category: catA }).expect(200);
      expect(names(a)).toEqual(['Alpha AI', 'Beta Analytics']);
      expect(a.body.pagination.total).toBe(2);

      const b = await search({ category: catB }).expect(200);
      expect(names(b)).toEqual(['Gamma Newsletter']);
    });

    it('no category ("All categories") restores every public result', async () => {
      const res = await search({ q: tok }).expect(200);
      expect(names(res).sort()).toEqual(['Alpha AI', 'Beta Analytics', 'Gamma Newsletter']);
    });

    it('search matches real records case-insensitively', async () => {
      expect(names(await search({ q: `analytics ${tok}` }).expect(200))).toEqual([
        'Beta Analytics',
      ]);
      expect(names(await search({ q: `ALPHA ${tok.toUpperCase()}` }).expect(200))).toEqual([
        'Alpha AI',
      ]);
      // Description is searched too.
      expect(names(await search({ q: `copywriting ${tok}` }).expect(200))).toEqual(['Alpha AI']);
    });

    it('search and category combine', async () => {
      expect(names(await search({ q: tok, category: catB }).expect(200))).toEqual([
        'Gamma Newsletter',
      ]);
      const none = await search({ q: `alpha ${tok}`, category: catB }).expect(200);
      expect(none.body.data).toEqual([]);
      expect(none.body.pagination).toMatchObject({ total: 0, totalPages: 0, hasMore: false });
    });

    it('price and monthly revenue filters combine; undisclosed revenue never matches a revenue filter', async () => {
      expect(
        names(await search({ q: tok, minPrice: 15_000, minRevenue: 1_000 }).expect(200)),
      ).toEqual(['Beta Analytics']);
      expect(names(await search({ q: tok, maxRevenue: 3_000 }).expect(200))).toEqual(['Alpha AI']);
    });

    it('monthly profit filter uses profit, not revenue', async () => {
      const res = await search({
        q: tok,
        minProfit: 900,
        maxProfit: 1_600,
        sortBy: 'profit',
        sortDir: 'asc',
      });
      expect(names(res)).toEqual(['Beta Analytics', 'Gamma Newsletter']);
    });

    it('business model and verification filters', async () => {
      expect(names(await search({ q: tok, businessModel: 'newsletter' }).expect(200))).toEqual([
        'Gamma Newsletter',
      ]);
      expect(names(await search({ q: tok, verified: 'true' }).expect(200))).toEqual(['Alpha AI']);
    });

    it.each([
      [
        { sortBy: 'createdAt', sortDir: 'desc' },
        ['Alpha AI', 'Beta Analytics', 'Gamma Newsletter'],
      ],
      [{ sortBy: 'price', sortDir: 'asc' }, ['Alpha AI', 'Gamma Newsletter', 'Beta Analytics']],
      [{ sortBy: 'price', sortDir: 'desc' }, ['Beta Analytics', 'Gamma Newsletter', 'Alpha AI']],
      // Gamma has no monthly revenue → last, in either direction.
      [{ sortBy: 'revenue', sortDir: 'desc' }, ['Beta Analytics', 'Alpha AI', 'Gamma Newsletter']],
      [{ sortBy: 'revenue', sortDir: 'asc' }, ['Alpha AI', 'Beta Analytics', 'Gamma Newsletter']],
      [{ sortBy: 'profit', sortDir: 'desc' }, ['Gamma Newsletter', 'Beta Analytics', 'Alpha AI']],
    ])('sorts %o', async (sort, expected) => {
      expect(names(await search({ q: tok, ...sort }).expect(200))).toEqual(expected);
    });

    it('paginates with correct totals and no overlap', async () => {
      const p1 = await search({ q: tok, limit: 2, page: 1 }).expect(200);
      const p2 = await search({ q: tok, limit: 2, page: 2 }).expect(200);
      expect(p1.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasMore: true,
      });
      expect(p2.body.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasMore: false,
      });
      expect(p1.body.data).toHaveLength(2);
      expect(p2.body.data).toHaveLength(1);
      expect([...names(p1), ...names(p2)].sort()).toEqual([
        'Alpha AI',
        'Beta Analytics',
        'Gamma Newsletter',
      ]);
    });

    it('drafts, sold and private listings never appear; unlisted is link-only', async () => {
      const all = names(await search({ q: tok, limit: 50 }).expect(200));
      for (const hidden of ['Delta Draft', 'Epsilon Sold', 'Zeta Private', 'Eta Unlisted']) {
        expect(all).not.toContain(hidden);
      }
      await http().get(`/api/v1/listings/${biz.draft}`).expect(404);
      await http().get(`/api/v1/listings/${biz.sold}`).expect(404);
      await http().get(`/api/v1/listings/${biz.private}`).expect(404);
      await http().get(`/api/v1/listings/${biz.unlisted}`).expect(200);
    });

    it('returns an empty page (not an error) when nothing matches', async () => {
      const res = await search({ q: `no-such-business-${tok}` }).expect(200);
      expect(res.body).toEqual({
        data: [],
        pagination: { page: 1, limit: 12, total: 0, totalPages: 0, hasMore: false },
      });
    });

    it.each([
      [{ minPrice: -1 }],
      [{ minPrice: 'abc' }],
      [{ minPrice: 100, maxPrice: 50 }],
      [{ minRevenue: 10, maxRevenue: 5 }],
      [{ sortBy: 'passwordHash' }],
      [{ sortDir: 'sideways' }],
      [{ page: 0 }],
      [{ limit: 500 }],
      [{ category: "x' OR '1'='1" }],
      [{ verified: 'maybe' }],
      [{ ownerEmail: 'a@example.com' }],
    ])('rejects invalid filter %o with 400', async (query) => {
      const res = await search(query as Record<string, string | number>).expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('reports real figures: no annual→monthly conversion, verified flags per metric', async () => {
      const res = await search({ q: tok, limit: 50 }).expect(200);
      const byName = Object.fromEntries(
        (res.body.data as Array<Record<string, unknown>>).map((l) => [
          String(l.name).replace(` ${tok}`, ''),
          l,
        ]),
      );
      expect(byName['Gamma Newsletter']).toMatchObject({
        monthlyRevenue: null,
        monthlyProfit: 1_500,
      });
      expect(byName['Beta Analytics']).toMatchObject({
        monthlyRevenue: 5_000,
        monthlyRevenueVerified: false,
        monthlyProfit: 1_000,
        monthlyProfitVerified: true,
        verified: false,
      });
      // Latest MRR period wins over the older one.
      expect(byName['Alpha AI']).toMatchObject({
        askingPrice: 10_000,
        monthlyRevenue: 2_000,
        verified: true,
      });
      expect(byName['Alpha AI'].seller).not.toHaveProperty('email');
    });

    it('price bounds are inclusive', async () => {
      // Alpha is exactly 10 000, Gamma exactly 20 000.
      const res = await search({
        q: tok,
        minPrice: 10_000,
        maxPrice: 20_000,
        sortBy: 'price',
        sortDir: 'asc',
      });
      expect(names(res)).toEqual(['Alpha AI', 'Gamma Newsletter']);
    });

    it('category and asking price are required when creating a listing', async () => {
      const res = await http()
        .post('/api/v1/businesses')
        .set('Cookie', users.seller.cookies)
        .send({ name: `No price ${tok}`, description: 'x', businessModel: 'SaaS' })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(/categoryId/);
      expect(JSON.stringify(res.body)).toMatch(/askingPrice/);
    });

    it('publishing an incomplete listing names the missing fields', async () => {
      const draft = await prisma.business.create({
        data: {
          ownerId: users.seller.id,
          name: `Incomplete ${tok}`,
          slug: `incomplete-${tok}`,
          businessModel: 'SaaS',
          listing: { create: {} },
        },
      });
      const owned = await http()
        .get('/api/v1/businesses')
        .set('Cookie', users.seller.cookies)
        .expect(200);
      const mine = (owned.body.data as Array<{ id: string; missingForPublish: string[] }>).find(
        (b) => b.id === draft.id,
      );
      expect(mine?.missingForPublish).toEqual(['description', 'categoryId', 'askingPrice']);

      const res = await http()
        .post(`/api/v1/businesses/${draft.id}/publish`)
        .set('Cookie', users.seller.cookies)
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'LISTING_INCOMPLETE',
        details: { missing: ['description', 'categoryId', 'askingPrice'] },
      });
    });

    it('a new metric refreshes the listing snapshot', async () => {
      await http()
        .post(`/api/v1/businesses/${biz.alpha}/metrics`)
        .set('Cookie', users.seller.cookies)
        .send({ metricType: 'MRR', value: 2_500, period: '2026-10-01' })
        .expect(201);
      const res = await search({ q: `alpha ${tok}` }).expect(200);
      expect(res.body.data[0].monthlyRevenue).toBe(2_500);
    });

    it('facets list business models of public listings', async () => {
      const res = await http().get('/api/v1/listings/facets').expect(200);
      const models = res.body.data.businessModels as Array<{ value: string; count: number }>;
      expect(models.map((m) => m.value.toLowerCase())).toEqual(
        expect.arrayContaining(['saas', 'newsletter']),
      );
    });
  });

  describe('seller discovery', () => {
    it('a seller with public listings has a public profile without private data', async () => {
      const res = await http().get(`/api/v1/sellers/${users.seller2.id}`).expect(200);
      expect(res.body.data).toMatchObject({
        id: users.seller2.id,
        company: 'seller2 Co',
        publicListings: 1,
      });
      expect(res.body.data).not.toHaveProperty('email');
      expect(names(await search({ sellerId: users.seller2.id }).expect(200))).toEqual([
        'Gamma Newsletter',
      ]);
    });

    it('users without public listings have no seller profile', async () => {
      await http().get(`/api/v1/sellers/${users.buyer.id}`).expect(404);
      await http().get('/api/v1/sellers/not-a-uuid').expect(400);
    });
  });

  describe('buyer → seller conversation', () => {
    const start = (
      who: keyof typeof users,
      businessId: string,
      body: Record<string, unknown> = {},
    ) =>
      http()
        .post(`/api/v1/businesses/${businessId}/conversations`)
        .set('Cookie', users[who].cookies)
        .send(body);

    it('requires authentication', async () => {
      await http().post(`/api/v1/businesses/${biz.alpha}/conversations`).send({}).expect(401);
      await http().get('/api/v1/conversations').expect(401);
    });

    it('buyer starts a conversation with the actual seller of the business', async () => {
      const res = await start('buyer', biz.alpha, {
        message: 'Is the business still available?',
      }).expect(201);
      conversationId = res.body.data.id;
      expect(res.body.data).toMatchObject({
        created: true,
        businessId: biz.alpha,
        buyerId: users.buyer.id,
        sellerId: users.seller.id,
      });
      const participantIds = (res.body.data.participants as Array<{ userId: string }>).map(
        (p) => p.userId,
      );
      expect(participantIds.sort()).toEqual([users.buyer.id, users.seller.id].sort());
    });

    it('starting again returns the same conversation instead of a duplicate', async () => {
      const res = await start('buyer', biz.alpha, { message: 'Following up' }).expect(201);
      expect(res.body.data).toMatchObject({ id: conversationId, created: false });
      expect(
        await prisma.conversation.count({
          where: { businessId: biz.alpha, buyerId: users.buyer.id },
        }),
      ).toBe(1);
    });

    it('a client-supplied seller id cannot redirect the conversation', async () => {
      // Body fields beyond `message` are rejected outright.
      await start('buyer', biz.alpha, { sellerId: users.seller2.id }).expect(400);
      // The legacy endpoint refuses a participant who is not the business's seller.
      await http()
        .post('/api/v1/conversations')
        .set('Cookie', users.buyer.cookies)
        .send({ participantIds: [users.seller2.id], businessId: biz.alpha, initialMessage: 'hi' })
        .expect(403);
    });

    it('cannot contact sellers of non-public businesses, or as a non-buyer', async () => {
      await start('buyer', biz.draft).expect(404);
      await start('buyer', biz.sold).expect(404);
      await start('seller2', biz.alpha).expect(403);
      await start('buyer', 'not-a-uuid').expect(400);
    });

    it('validates message content', async () => {
      await start('buyer', biz.alpha, { message: '   ' }).expect(400);
      await start('buyer', biz.alpha, { message: 'x'.repeat(5001) }).expect(400);
    });

    it('the seller sees the conversation with unread count and can read it', async () => {
      const list = await http()
        .get('/api/v1/conversations')
        .set('Cookie', users.seller.cookies)
        .expect(200);
      const conv = (
        list.body.data as Array<{ id: string; unreadCount: number; business: { name: string } }>
      ).find((c) => c.id === conversationId);
      expect(conv).toMatchObject({ unreadCount: 2, business: { name: `Alpha AI ${tok}` } });

      const messages = await http()
        .get(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', users.seller.cookies)
        .expect(200);
      expect((messages.body.data as Array<{ body: string }>).map((m) => m.body)).toEqual([
        'Following up',
        'Is the business still available?',
      ]);

      const after = await http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set('Cookie', users.seller.cookies)
        .expect(200);
      expect(after.body.data.unreadCount).toBe(0);
    });

    it('the seller replies and the buyer sees the persisted thread with timestamps', async () => {
      await http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', users.seller.cookies)
        .send({ body: 'Yes — happy to share details.' })
        .expect(201);

      const res = await http()
        .get(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', users.buyer.cookies)
        .expect(200);
      const messages = res.body.data as Array<{
        body: string;
        senderId: string;
        createdAt: string;
      }>;
      expect(messages[0]).toMatchObject({
        body: 'Yes — happy to share details.',
        senderId: users.seller.id,
      });
      expect(messages.every((m) => !Number.isNaN(Date.parse(m.createdAt)))).toBe(true);
      expect(await prisma.message.count({ where: { conversationId } })).toBe(3);
    });

    it('an unrelated user cannot read, open or post to the conversation', async () => {
      const outsider = users.outsider.cookies;
      await http()
        .get(`/api/v1/conversations/${conversationId}`)
        .set('Cookie', outsider)
        .expect(403);
      await http()
        .get(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', outsider)
        .expect(403);
      await http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', outsider)
        .send({ body: 'let me in' })
        .expect(403);
      const list = await http().get('/api/v1/conversations').set('Cookie', outsider).expect(200);
      expect((list.body.data as Array<{ id: string }>).map((c) => c.id)).not.toContain(
        conversationId,
      );
    });

    it('a message cannot be sent as someone else', async () => {
      await http()
        .post(`/api/v1/conversations/${conversationId}/messages`)
        .set('Cookie', users.buyer.cookies)
        .send({ body: 'spoof', senderId: users.seller.id })
        .expect(400);
    });
  });

  describe('existing role boundaries still hold', () => {
    it('a buyer cannot create a business and public registration cannot create an admin', async () => {
      await http()
        .post('/api/v1/businesses')
        .set('Cookie', users.buyer.cookies)
        .send({ name: 'Nope' })
        .expect(403);
      await http()
        .post('/api/v1/auth/register')
        .send({ email: `sneaky-${tok}@example.com`, password, role: 'ADMIN' })
        .expect(400);
    });

    it('a seller cannot manage another seller’s business', async () => {
      await http()
        .patch(`/api/v1/businesses/${biz.gamma}/listing`)
        .set('Cookie', users.seller.cookies)
        .send({ askingPrice: 1 })
        .expect(404);
    });
  });
});
