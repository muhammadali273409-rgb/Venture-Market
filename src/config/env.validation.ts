import { z } from 'zod';

// Same format parseDurationMs accepts — a typo here would otherwise only
// surface as a 500 on every login, when the token is signed.
const duration = z
  .string()
  .trim()
  .regex(/^\d+[smhd]$/, 'must be a duration like "15m", "1h" or "30d"');

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'minio',
  'host.docker.internal',
]);
const PLACEHOLDERS = new Set(['changeme', 'change-me', 'minioadmin', 'xxx', '...']);
const R2_HINT =
  'production needs real object storage (Cloudflare R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com) — see DEPLOYMENT.md';

/**
 * In production, refuse to boot with the local-dev MinIO settings from
 * .env.example — otherwise every upload fails later with ECONNREFUSED.
 */
function productionStorageIssues(env: {
  STORAGE_ENDPOINT: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
}): z.IssueData[] {
  const issues: z.IssueData[] = [];
  let url: URL | null = null;
  try {
    url = new URL(env.STORAGE_ENDPOINT);
  } catch {
    // already reported by .url()
  }
  if (url && (LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.local'))) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_ENDPOINT'],
      message: `points to ${url.hostname}, which does not exist on the server; ${R2_HINT}`,
    });
  } else if (url && url.protocol !== 'https:') {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_ENDPOINT'],
      message: 'must use https:// in production',
    });
  }
  for (const key of ['STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'] as const) {
    if (PLACEHOLDERS.has(env[key].trim().toLowerCase())) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `is still the example placeholder; ${R2_HINT}`,
      });
    }
  }
  return issues;
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ENABLE_SWAGGER: z.coerce.boolean().default(false),
    PORT: z.coerce.number().default(3000),
    APP_URL: z.string().url(),
    FRONTEND_URL: z.string().url(),
    API_PREFIX: z.string().default('api/v1'),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    JWT_SECRET: z.string().min(16),
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_REFRESH_TTL: duration.default('30d'),
    COOKIE_SECRET: z.string().min(16),

    STORAGE_ENDPOINT: z.string().url(),
    STORAGE_REGION: z.string().default('auto'),
    STORAGE_BUCKET: z.string().min(1),
    STORAGE_ACCESS_KEY: z.string().min(1),
    STORAGE_SECRET_KEY: z.string().min(1),
    // Not z.coerce.boolean(): that turns the string "false" into true.
    STORAGE_FORCE_PATH_STYLE: z
      .string()
      .default('true')
      .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
    // Download links are meant to be short-lived: 30 s – 1 h.
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    // Optional server-side encryption header for PutObject (AWS S3: AES256 or aws:kms).
    STORAGE_SSE: z.enum(['', 'AES256', 'aws:kms']).default(''),

    EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend', 'brevo']).default('console'),
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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const issue of productionStorageIssues(env)) ctx.addIssue(issue);
    }
    if ((env.EMAIL_PROVIDER === 'resend' || env.EMAIL_PROVIDER === 'brevo') && !env.EMAIL_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_API_KEY'],
        message: `required when EMAIL_PROVIDER=${env.EMAIL_PROVIDER}`,
      });
    }
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
