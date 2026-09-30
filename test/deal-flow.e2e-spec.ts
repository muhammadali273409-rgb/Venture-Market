import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createTestApp } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

/**
 * End-to-end coverage of the core marketplace journey and the buyer/seller
 * role boundaries around it:
 * seller creates a listing -> submits it for review -> admin approves ->
 * buyer offers -> seller counters -> buyer accepts -> a Deal room is created
 * -> NDA -> due diligence. Also asserts the IDOR/object-level authorization
 * boundaries around offers, deals and documents.
 *
 * Requires a live PostgreSQL + Redis reachable via .env — point at a
 * disposable test database.
 */
describe('Deal flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const password = 'CorrectHorseBattery9!';
  const sellerEmail = `seller-${nanoid(8)}@example.com`;
  const buyerEmail = `buyer-${nanoid(8)}@example.com`;
  const outsiderEmail = `outsider-${nanoid(8)}@example.com`;
  const adminEmail = `admin-${nanoid(8)}@example.com`;

  let sellerCookies: string[];
  let buyerCookies: string[];
  let outsiderCookies: string[];
  let adminCookies: string[];
  let categoryId: string;
  let businessId: string;
  let offerId: string;
  let dealId: string;
  let dealDocumentId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    await registerAndVerify(sellerEmail, 'SELLER');
    await registerAndVerify(buyerEmail, 'BUYER');
    await registerAndVerify(outsiderEmail, 'BUYER');
    // Admins are never created through public registration — promote directly.
    await registerAndVerify(adminEmail, 'BUYER');
    await prisma.user.update({ where: { email: adminEmail }, data: { role: 'ADMIN' } });

    sellerCookies = await login(sellerEmail);
    buyerCookies = await login(buyerEmail);
    outsiderCookies = await login(outsiderEmail);
    adminCookies = await login(adminEmail);

    const category = await prisma.businessCategory.upsert({
      where: { name: `E2E Category ${nanoid(4)}` },
      create: { name: `E2E Category ${nanoid(4)}`, slug: `e2e-category-${nanoid(6)}` },
      update: {},
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerAndVerify(email: string, role: 'BUYER' | 'SELLER'): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, role })
      .expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
  }

  async function login(email: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return res.headers['set-cookie'] as unknown as string[];
  }

  it('public registration cannot create an admin', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `sneaky-${nanoid(8)}@example.com`, password, role: 'ADMIN' })
      .expect(400);
  });

  it('a buyer cannot create a business', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/businesses')
      .set('Cookie', buyerCookies)
      .send({ name: 'Not allowed' })
      .expect(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('seller creates a business', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/businesses')
      .set('Cookie', sellerCookies)
      .send({
        name: `E2E Test Business ${nanoid(6)}`,
        description: 'A test SaaS business for e2e coverage',
        categoryId,
        businessModel: 'SaaS',
        country: 'US',
      })
      .expect(201);

    businessId = res.body.data.id;
    expect(res.body.data.status).toBe('DRAFT');
  });

  it('buyer cannot see the unpublished business via the public listings detail endpoint', async () => {
    await request(app.getHttpServer()).get(`/api/v1/listings/${businessId}`).expect(404);
  });

  it('outsider cannot fetch the business via the owner-only endpoint (IDOR check)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/businesses/${businessId}`)
      .set('Cookie', outsiderCookies)
      .expect(404);
    expect(res.body.error.code).toBe('BUSINESS_NOT_FOUND');
  });

  it('seller sets an asking price and submits the listing for review — it is not live yet', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${businessId}/listing`)
      .set('Cookie', sellerCookies)
      .send({ askingPrice: 50000, visibility: 'PUBLIC' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/submit-review`)
      .set('Cookie', sellerCookies)
      .expect(201);

    expect(res.body.data.status).toBe('PENDING_REVIEW');
    await request(app.getHttpServer()).get(`/api/v1/listings/${businessId}`).expect(404);
  });

  it('seller cannot edit the listing while it is under review', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/businesses/${businessId}/listing`)
      .set('Cookie', sellerCookies)
      .send({ askingPrice: 1 })
      .expect(409);
    expect(res.body.error.code).toBe('BUSINESS_LOCKED');
  });

  it('seller cannot approve their own business', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/businesses/${businessId}/approve`)
      .set('Cookie', sellerCookies)
      .expect(403);
  });

  it('an admin approves the business and it appears in public search', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/admin/businesses/${businessId}/approve`)
      .set('Cookie', adminCookies)
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/listings').expect(200);
    expect(res.body.data.some((item: { id: string }) => item.id === businessId)).toBe(true);
  });

  it('a seller account cannot make offers', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/offers`)
      .set('Cookie', sellerCookies)
      .send({ amount: 40000 })
      .expect(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('buyer submits an offer', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/offers`)
      .set('Cookie', buyerCookies)
      .send({ amount: 40000, terms: 'Cash, 30-day close', message: 'Keen to move fast' })
      .expect(201);

    offerId = res.body.data.id;
    expect(res.body.data.status).toBe('SUBMITTED');
  });

  it('buyer cannot stack a second open offer on the same business', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/offers`)
      .set('Cookie', buyerCookies)
      .send({ amount: 41000 })
      .expect(409);
  });

  it('an outsider cannot read the offer (IDOR check)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/offers/${offerId}`)
      .set('Cookie', outsiderCookies)
      .expect(404);
  });

  it('an outsider cannot accept the offer (IDOR check)', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offerId}/accept`)
      .set('Cookie', outsiderCookies)
      .expect(404);
  });

  it('buyer cannot accept their own offer', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offerId}/accept`)
      .set('Cookie', buyerCookies)
      .expect(403);
    expect(res.body.error.code).toBe('OFFER_NOT_ALLOWED');
  });

  it('seller counters the offer', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offerId}/counter`)
      .set('Cookie', sellerCookies)
      .send({ amount: 46000 })
      .expect(201);

    offerId = res.body.data.id; // counter creates a new Offer row in the chain
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.amount).toBe(46000);
  });

  it('buyer accepts the counter — a Deal is created and the listing is paused, not sold', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offerId}/accept`)
      .set('Cookie', buyerCookies)
      .expect(201);

    dealId = res.body.data.id;
    expect(res.body.data.status).toBe('INITIATED');

    const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(business.status).toBe('PAUSED');
  });

  it('a second accept attempt on the same offer fails (no double-accept race)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offerId}/accept`)
      .set('Cookie', buyerCookies)
      .expect(409);
    expect(res.body.error.code).toBe('OFFER_ALREADY_ACCEPTED');
  });

  it('seller cannot relist the business while the deal is active', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/resume`)
      .set('Cookie', sellerCookies)
      .expect(409);
    expect(res.body.error.code).toBe('BUSINESS_LOCKED');
  });

  it('an outsider cannot read the deal room (IDOR check)', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/deals/${dealId}`)
      .set('Cookie', outsiderCookies)
      .expect(403);
  });

  it('both deal participants can read the deal room, without private user fields', async () => {
    const asBuyer = await request(app.getHttpServer())
      .get(`/api/v1/deals/${dealId}`)
      .set('Cookie', buyerCookies)
      .expect(200);
    const asSeller = await request(app.getHttpServer())
      .get(`/api/v1/deals/${dealId}`)
      .set('Cookie', sellerCookies)
      .expect(200);

    expect(asBuyer.body.data.participants).toHaveLength(2);
    expect(asSeller.body.data.participants).toHaveLength(2);
    for (const participant of asBuyer.body.data.participants) {
      expect(participant.user.passwordHash).toBeUndefined();
      expect(participant.user.email).toBeUndefined();
    }
  });

  it('a party cannot skip protected deal stages', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/deals/${dealId}/status`)
      .set('Cookie', sellerCookies)
      .send({ status: 'COMPLETED' })
      .expect(409);
  });

  it('a seller cannot re-role the buyer through the participants endpoint', async () => {
    const buyer = await prisma.user.findUniqueOrThrow({ where: { email: buyerEmail } });
    await request(app.getHttpServer())
      .post(`/api/v1/deals/${dealId}/participants`)
      .set('Cookie', sellerCookies)
      .send({ userId: buyer.id, role: 'ACCOUNTANT' })
      .expect(409);
  });

  it('a deal document is hidden from the buyer until the NDA is signed', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post(`/api/v1/businesses/${businessId}/documents`)
      .set('Cookie', sellerCookies)
      .field('dealId', dealId)
      .field('category', 'FINANCIAL')
      .attach('file', Buffer.from('confidential financials'), {
        filename: 'financials.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    dealDocumentId = uploadRes.body.data.id;

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${dealDocumentId}/download`)
      .set('Cookie', outsiderCookies)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/documents/${dealDocumentId}/download`)
      .set('Cookie', buyerCookies)
      .expect(403);
  });

  it('both parties sign the NDA and due diligence opens automatically', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/deals/${dealId}/status`)
      .set('Cookie', buyerCookies)
      .send({ status: 'NDA' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/deals/${dealId}/nda/sign`)
      .set('Cookie', buyerCookies)
      .expect(201);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/deals/${dealId}/nda/sign`)
      .set('Cookie', sellerCookies)
      .expect(201);

    expect(res.body.data.status).toBe('DUE_DILIGENCE');
  });

  it('after the NDA the buyer can download the deal document; the outsider still cannot', async () => {
    const asBuyer = await request(app.getHttpServer())
      .get(`/api/v1/documents/${dealDocumentId}/download`)
      .set('Cookie', buyerCookies)
      .expect(200);
    expect(asBuyer.body.data.url).toBeDefined();

    await request(app.getHttpServer())
      .get(`/api/v1/documents/${dealDocumentId}/download`)
      .set('Cookie', outsiderCookies)
      .expect(403);
  });

  it('only the buyer requests due diligence; the seller cannot approve items', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/deals/${dealId}/due-diligence`)
      .set('Cookie', sellerCookies)
      .send({ category: 'FINANCIAL', title: 'P&L', items: ['Last 12 months P&L'] })
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(`/api/v1/deals/${dealId}/due-diligence`)
      .set('Cookie', buyerCookies)
      .send({ category: 'FINANCIAL', title: 'P&L', items: ['Last 12 months P&L'] })
      .expect(201);
    const itemId = created.body.data.items[0].id;

    await request(app.getHttpServer())
      .patch(`/api/v1/deals/${dealId}/due-diligence/items/${itemId}`)
      .set('Cookie', sellerCookies)
      .send({ status: 'APPROVED' })
      .expect(403);
  });
});
