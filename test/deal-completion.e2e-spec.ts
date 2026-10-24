import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createTestApp } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

/**
 * The whole deal, end to end, through the public API with real storage:
 * listing → offer → accept → NDA → due diligence (request, answer with a
 * document, approve, close) → agreement (create, upload PDF version, both
 * sign) → manual payment (buyer marks paid, admin confirms) → transfer →
 * receipt → COMPLETED, with the business and listing SOLD.
 *
 * Needs PostgreSQL, Redis and an S3-compatible bucket from .env, and
 * PAYMENT_PROVIDER=manual (the default).
 */
describe('Deal completion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const password = 'CorrectHorseBattery9!';
  const tok = nanoid(6);
  const cookies: Record<'seller' | 'buyer' | 'admin', string[]> = {
    seller: [],
    buyer: [],
    admin: [],
  };
  let businessId: string;
  let dealId: string;
  const http = () => request(app.getHttpServer());
  const pdf = Buffer.from(`%PDF-1.4\n% e2e purchase agreement ${tok}\n%%EOF\n`);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const who of ['seller', 'buyer', 'admin'] as const) {
      const email = `${who}-${tok}@example.com`;
      await http()
        .post('/api/v1/auth/register')
        .send({ email, password, role: who === 'seller' ? 'SELLER' : 'BUYER' })
        .expect(201);
      if (who === 'admin') {
        await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
      }
      const res = await http().post('/api/v1/auth/login').send({ email, password }).expect(200);
      cookies[who] = res.headers['set-cookie'] as unknown as string[];
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (who: keyof typeof cookies) => ({
    get: (url: string) => http().get(url).set('Cookie', cookies[who]),
    post: (url: string) => http().post(url).set('Cookie', cookies[who]),
    patch: (url: string) => http().patch(url).set('Cookie', cookies[who]),
  });
  const deal = () => prisma.deal.findUniqueOrThrow({ where: { id: dealId } });

  it('seller publishes, buyer offers, seller accepts → a deal room exists', async () => {
    const category = await prisma.businessCategory.create({
      data: { name: `Deal E2E ${tok}`, slug: `deal-e2e-${tok.toLowerCase()}` },
    });
    const created = await as('seller')
      .post('/api/v1/businesses')
      .send({
        name: `Muhammadshop E2E ${tok}`,
        description: 'Online shop used by the deal completion e2e test',
        categoryId: category.id,
        businessModel: 'E-commerce',
        askingPrice: 50_000,
        country: 'TJ',
      })
      .expect(201);
    businessId = created.body.data.id;
    await as('seller').post(`/api/v1/businesses/${businessId}/publish`).expect(201);

    const offer = await as('buyer')
      .post(`/api/v1/businesses/${businessId}/offers`)
      .send({ amount: 45_000 })
      .expect(201);
    await as('seller').post(`/api/v1/offers/${offer.body.data.id}/accept`).expect(201);

    const dealRow = await prisma.deal.findFirstOrThrow({ where: { businessId } });
    dealId = dealRow.id;
    const res = await as('buyer').get(`/api/v1/deals/${dealId}`).expect(200);
    expect(res.body.data.acceptedOffer).toEqual({ amount: 45_000, currency: 'USD' });
  });

  it('both parties sign the NDA → DUE_DILIGENCE', async () => {
    await as('buyer').patch(`/api/v1/deals/${dealId}/status`).send({ status: 'NDA' }).expect(200);
    await as('seller').post(`/api/v1/deals/${dealId}/nda/sign`).expect(201);
    await as('buyer').post(`/api/v1/deals/${dealId}/nda/sign`).expect(201);
    expect((await deal()).status).toBe('DUE_DILIGENCE');
  });

  it('due diligence cannot be closed with zero items', async () => {
    const res = await as('buyer')
      .patch(`/api/v1/deals/${dealId}/status`)
      .send({ status: 'AGREEMENT' })
      .expect(409);
    expect(res.body.error.code).toBe('DUE_DILIGENCE_NO_ITEMS');
  });

  it('buyer requests, seller answers with a document, buyer approves and closes → AGREEMENT', async () => {
    const created = await as('buyer')
      .post(`/api/v1/deals/${dealId}/due-diligence`)
      .send({ category: 'FINANCIAL', title: 'P&L 2025', items: ['Profit and loss statement'] })
      .expect(201);
    const itemId = created.body.data.items[0].id;

    const open = await as('buyer')
      .patch(`/api/v1/deals/${dealId}/status`)
      .send({ status: 'AGREEMENT' })
      .expect(409);
    expect(open.body.error.code).toBe('DUE_DILIGENCE_ITEMS_OPEN');

    const doc = await as('seller')
      .post(`/api/v1/businesses/${businessId}/documents`)
      .field('dealId', dealId)
      .field('category', 'FINANCIAL')
      .attach('file', pdf, { filename: 'pnl-2025.pdf', contentType: 'application/pdf' })
      .expect(201);
    await as('seller')
      .patch(`/api/v1/deals/${dealId}/due-diligence/items/${itemId}`)
      .send({ status: 'UPLOADED', response: 'Attached the 2025 P&L', documentId: doc.body.data.id })
      .expect(200);

    // The buyer can open the shared document.
    await as('buyer').get(`/api/v1/documents/${doc.body.data.id}/download`).expect(200);

    await as('seller')
      .patch(`/api/v1/deals/${dealId}/status`)
      .send({ status: 'AGREEMENT' })
      .expect(403);
    await as('buyer')
      .patch(`/api/v1/deals/${dealId}/due-diligence/items/${itemId}`)
      .send({ status: 'APPROVED' })
      .expect(200);
    await as('buyer')
      .patch(`/api/v1/deals/${dealId}/status`)
      .send({ status: 'AGREEMENT' })
      .expect(200);
    expect((await deal()).status).toBe('AGREEMENT');
  });

  it('agreement: create, upload the PDF as a version, both sign → TRANSACTION', async () => {
    const agreement = await as('seller')
      .post(`/api/v1/deals/${dealId}/agreements`)
      .send({ title: `Шартномаи хариду фурӯши ${tok}` })
      .expect(201);
    const agreementId = agreement.body.data.id;

    const doc = await as('seller')
      .post(`/api/v1/businesses/${businessId}/documents`)
      .field('dealId', dealId)
      .field('category', 'LEGAL')
      .attach('file', pdf, { filename: 'agreement.pdf', contentType: 'application/pdf' })
      .expect(201);
    const contentHash = createHash('sha256').update(pdf).digest('hex');
    const version = await as('seller')
      .post(`/api/v1/deals/${dealId}/agreements/${agreementId}/versions`)
      .send({ documentId: doc.body.data.id, contentHash })
      .expect(201);
    expect(version.body.data).toMatchObject({
      version: 1,
      documentId: doc.body.data.id,
      contentHash,
    });

    const signUrl = `/api/v1/deals/${dealId}/agreements/${agreementId}/versions/${version.body.data.id}/sign`;
    await as('admin').post(signUrl).expect(403);
    await as('buyer').post(signUrl).expect(201);
    let list = await as('buyer').get(`/api/v1/deals/${dealId}/agreements`).expect(200);
    expect(list.body.data[0].status).toBe('PARTIALLY_SIGNED');
    expect((await deal()).status).toBe('AGREEMENT');

    await as('seller').post(signUrl).expect(201);
    list = await as('seller').get(`/api/v1/deals/${dealId}/agreements`).expect(200);
    expect(list.body.data[0].status).toBe('SIGNED');
    expect(list.body.data[0].versions[0].signatures).toHaveLength(2);
    expect((await deal()).status).toBe('TRANSACTION');
  });

  it('manual payment: buyer marks paid; only an admin confirm moves the deal to TRANSFER', async () => {
    const before = await as('buyer').get(`/api/v1/deals/${dealId}/transaction`).expect(200);
    expect(before.body.data).toBeNull();
    const config = await as('buyer').get('/api/v1/payments/config').expect(200);
    expect(config.body.data.provider).toBe('manual');

    await as('seller').post(`/api/v1/deals/${dealId}/transaction/mark-paid`).send({}).expect(403);
    const marked = await as('buyer')
      .post(`/api/v1/deals/${dealId}/transaction/mark-paid`)
      .send({ reference: `TRX-${tok}` })
      .expect(201);
    expect(marked.body.data).toMatchObject({
      status: 'PROCESSING',
      provider: 'manual',
      amount: 45_000,
    });
    expect((await deal()).status).toBe('TRANSACTION');

    const txId = marked.body.data.id;
    await as('buyer').post(`/api/v1/admin/transactions/${txId}/confirm`).expect(403);
    await as('seller').post(`/api/v1/admin/transactions/${txId}/confirm`).expect(403);

    const queue = await as('admin').get('/api/v1/admin/transactions?status=PROCESSING').expect(200);
    expect(queue.body.data.map((t: { id: string }) => t.id)).toContain(txId);

    await as('admin').post(`/api/v1/admin/transactions/${txId}/confirm`).expect(201);
    expect((await deal()).status).toBe('TRANSFER');
  });

  it('seller confirms transfer, buyer confirms receipt → COMPLETED and SOLD', async () => {
    await as('buyer').post(`/api/v1/deals/${dealId}/confirm-receipt`).expect(409);
    await as('buyer').post(`/api/v1/deals/${dealId}/confirm-transfer`).expect(403);
    await as('seller').post(`/api/v1/deals/${dealId}/confirm-transfer`).expect(201);
    await as('buyer').post(`/api/v1/deals/${dealId}/confirm-receipt`).expect(201);

    expect((await deal()).status).toBe('COMPLETED');
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      include: { listing: true },
    });
    expect(business.status).toBe('SOLD');
    expect(business.listing?.status).toBe('SOLD');
  });
});
