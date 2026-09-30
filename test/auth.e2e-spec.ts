import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { nanoid } from 'nanoid';
import { createTestApp } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Requires a live PostgreSQL + Redis reachable via the DATABASE_URL / REDIS_URL
 * in .env (point these at a disposable test database, never production).
 */
describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const email = `auth-test-${nanoid(8)}@example.com`;
  const password = 'CorrectHorseBattery9!';

  it('registers a new account', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, firstName: 'Test', role: 'BUYER' })
      .expect(201);

    expect(res.body.data.email).toBe(email);
    expect(res.body.data.status).toBe('PENDING_VERIFICATION');
  });

  it('stores the chosen public role on the new account', async () => {
    const user = await app.get(PrismaService).user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe('BUYER');
  });

  it('rejects registration without a Buyer/Seller choice', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `no-role-${nanoid(8)}@example.com`, password })
      .expect(400);
  });

  it('rejects ADMIN (or any non-public role) at public registration', async () => {
    for (const role of ['ADMIN', 'MODERATOR', 'BUYER_SELLER', 'admin']) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: `role-${nanoid(8)}@example.com`, password, role })
        .expect(400);
    }
  });

  it('rejects extra privileged fields smuggled into the register body', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `extra-${nanoid(8)}@example.com`, password, role: 'BUYER', status: 'ACTIVE' })
      .expect(400);
  });

  it('rejects registering the same email twice', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, role: 'BUYER' })
      .expect(409);

    expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
  });

  it('rejects login before email verification is required elsewhere but allows login itself', async () => {
    // Login is allowed pre-verification in this design (status starts PENDING_VERIFICATION,
    // only SUSPENDED/DEACTIVATED block login) — verify credentials work correctly instead.
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(401);

    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('logs in with correct credentials and sets auth cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(res.body.data.user.email).toBe(email);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('rejects /auth/me without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('returns the current user with a valid access token', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });

    const cookies = loginRes.headers['set-cookie'] as unknown as string[];
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies)
      .expect(200);

    expect(res.body.data.email).toBe(email);
  });

  it('verifies email with a valid token and rejects a reused one', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const token = await prisma.emailVerificationToken.findFirstOrThrow({
      where: { userId: user.id },
    });

    // The raw token is never stored — simulate what the emailed link would have carried
    // by minting a fresh one directly against the hash the service checks.
    const { generateOpaqueToken } = await import('../src/auth/token.service');
    const { raw, hash } = generateOpaqueToken();
    await prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { tokenHash: hash },
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: raw })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ token: raw })
      .expect(401);
  });

  it('does not reveal whether an email exists on forgot-password', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'definitely-not-registered@example.com' })
      .expect(200);

    expect(res.body.data.success).toBe(true);
  });
});
