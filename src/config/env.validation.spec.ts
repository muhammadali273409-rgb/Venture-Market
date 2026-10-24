import { envSchema } from './env.validation';

const base = {
  APP_URL: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  JWT_SECRET: 'x'.repeat(16),
  JWT_REFRESH_SECRET: 'y'.repeat(16),
  COOKIE_SECRET: 'z'.repeat(16),
  STORAGE_ENDPOINT: 'https://r2.example',
  STORAGE_BUCKET: 'b',
  STORAGE_ACCESS_KEY: 'k',
  STORAGE_SECRET_KEY: 's',
};

describe('envSchema', () => {
  it('requires EMAIL_API_KEY for a real email provider', () => {
    expect(envSchema.safeParse({ ...base, EMAIL_PROVIDER: 'brevo' }).success).toBe(false);
    expect(
      envSchema.safeParse({ ...base, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_x' }).success,
    ).toBe(true);
    expect(envSchema.safeParse(base).success).toBe(true);
  });

  it('reads STORAGE_FORCE_PATH_STYLE="false" as false', () => {
    const parsed = envSchema.parse({ ...base, STORAGE_FORCE_PATH_STYLE: 'false' });
    expect(parsed.STORAGE_FORCE_PATH_STYLE).toBe(false);
    expect(envSchema.parse(base).STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('defaults deal payments to the manual (admin-confirmed) provider', () => {
    expect(envSchema.parse(base).PAYMENT_PROVIDER).toBe('manual');
    expect(envSchema.parse({ ...base, PAYMENT_PROVIDER: 'stripe' }).PAYMENT_PROVIDER).toBe(
      'stripe',
    );
    expect(envSchema.safeParse({ ...base, PAYMENT_PROVIDER: 'paypal' }).success).toBe(false);
  });

  it('rejects a malformed JWT_ACCESS_TTL', () => {
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_TTL: '15mgit ' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_TTL: '15m' }).success).toBe(true);
  });
});

describe('envSchema production storage checks', () => {
  const r2 = {
    ...base,
    NODE_ENV: 'production',
    STORAGE_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    STORAGE_ACCESS_KEY: 'a1b2c3',
    STORAGE_SECRET_KEY: 'd4e5f6',
  };
  const messages = (env: Record<string, unknown>) => {
    const result = envSchema.safeParse(env);
    return result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts a real R2 endpoint', () => {
    expect(messages(r2)).toEqual([]);
  });

  it('refuses to boot with the local MinIO endpoint', () => {
    expect(messages({ ...r2, STORAGE_ENDPOINT: 'http://localhost:9000' })).toEqual([
      expect.stringMatching(/^STORAGE_ENDPOINT: points to localhost.*R2/),
    ]);
  });

  it('refuses placeholder keys from .env.example', () => {
    expect(
      messages({ ...r2, STORAGE_ACCESS_KEY: 'changeme', STORAGE_SECRET_KEY: 'changeme' }),
    ).toHaveLength(2);
  });

  it('still allows local MinIO outside production', () => {
    expect(messages({ ...base, STORAGE_ENDPOINT: 'http://localhost:9000' })).toEqual([]);
  });
});
