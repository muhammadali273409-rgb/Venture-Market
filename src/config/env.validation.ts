import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ENABLE_SWAGGER: z.coerce.boolean().default(false),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  API_PREFIX: z.string().default('api/v1'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_REFRESH_TTL: z.string().default('30d'),
  COOKIE_SECRET: z.string().min(16),

  STORAGE_ENDPOINT: z.string().min(1),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().default(300),

  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
  EMAIL_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('VentureMarket <noreply@venturemarket.local>'),

  AI_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().optional().default(''),
  AI_MAX_REQUESTS_PER_DAY_FREE: z.coerce.number().default(5),
  AI_MAX_REQUESTS_PER_DAY_PRO: z.coerce.number().default(100),

  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),

  // Optional: "Continue with Google" is disabled (endpoint returns a config
  // error) whenever this is unset, so it's safe to leave blank in envs that
  // don't need it.
  GOOGLE_CLIENT_ID: z.string().optional().default(''),

  THROTTLE_TTL_SECONDS: z.coerce.number().default(60),
  THROTTLE_LIMIT: z.coerce.number().default(100),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
