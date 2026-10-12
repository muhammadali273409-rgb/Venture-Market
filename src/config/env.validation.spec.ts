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

  it('rejects a malformed JWT_ACCESS_TTL', () => {
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_TTL: '15mgit ' }).success).toBe(false);
    expect(envSchema.safeParse({ ...base, JWT_ACCESS_TTL: '15m' }).success).toBe(true);
  });
});
