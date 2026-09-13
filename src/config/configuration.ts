import { EnvConfig } from './env.validation';
 
export function buildConfiguration(env: EnvConfig) {
  return {
    nodeEnv: env.NODE_ENV,
    enableSwagger: env.ENABLE_SWAGGER,
    port: env.PORT,
    appUrl: env.APP_URL,
    frontendUrl: env.FRONTEND_URL,
    apiPrefix: env.API_PREFIX,
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtAccessTtl: env.JWT_ACCESS_TTL,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      jwtRefreshTtl: env.JWT_REFRESH_TTL,
      cookieSecret: env.COOKIE_SECRET,
    },
    storage: {
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: env.STORAGE_ACCESS_KEY,
      secretAccessKey: env.STORAGE_SECRET_KEY,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      apiKey: env.EMAIL_API_KEY,
      from: env.EMAIL_FROM,
    },
    ai: {
      provider: env.AI_PROVIDER,
      apiKey: env.AI_API_KEY,
      model: env.AI_MODEL,
      maxRequestsPerDayFree: env.AI_MAX_REQUESTS_PER_DAY_FREE,
      maxRequestsPerDayPro: env.AI_MAX_REQUESTS_PER_DAY_PRO,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
    },
    throttle: {
      ttlSeconds: env.THROTTLE_TTL_SECONDS,
      limit: env.THROTTLE_LIMIT,
    },
  };
}
 
export type AppConfiguration = ReturnType<typeof buildConfiguration>;
