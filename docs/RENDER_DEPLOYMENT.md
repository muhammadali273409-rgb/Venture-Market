# Render Deployment — VentureMarket Backend

This is the Render-specific runbook. For general local/Docker development, see `../DEPLOYMENT.md`.

## Root cause of "Invalid environment configuration" on boot

If Render logs show NestJS exiting immediately with `Invalid environment configuration: ... Required`
for `APP_URL`, `FRONTEND_URL`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`COOKIE_SECRET`, `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` —
**this is not a code defect.** `src/config/env.validation.ts` (a zod schema) intentionally has no
default for any of these, and `src/app.module.ts` validates `process.env` synchronously at boot
(`ConfigModule.forRoot({ load: [() => buildConfiguration(validateEnv(process.env))] })`), so the app
refuses to start rather than run with broken auth/storage/DB config.

Locally this doesn't happen because `ConfigModule.forRoot()` auto-loads a `.env` file from the
working directory via dotenv. Render's container has no `.env` (excluded by `.dockerignore`), so
`process.env` must already contain real values — supplied only by Render's **Environment →
Environment Variables** UI. The fix is configuring those variables with real infrastructure values,
not loosening validation.

## Render Web Service configuration

| Setting | Value |
|---|---|
| Name | `venturemarket-backend` |
| Runtime | Docker |
| Repository | this repo, `main` branch |
| Root Directory | repository root (where `Dockerfile` lives) |
| Region | as chosen (e.g. Oregon) |
| Build/Start Command | not set — Render uses the `Dockerfile`'s own `CMD ["node", "dist/main.js"]`, which already reads `process.env.PORT` |
| Health Check Path | `/api/v1/health` (or `${API_PREFIX}/health` if you change `API_PREFIX`) |
| Pre-Deploy Command | `npx prisma migrate deploy` — see [Migrations](#prisma-migrations) |

## Docker build (already working)

The multi-stage `Dockerfile` (`node:22-alpine`):
1. `deps` stage: `npm ci` with `package.json`/`package-lock.json`/`prisma/` only (better layer caching).
2. `build` stage: `npx prisma generate && npm run build && npm prune --omit=dev` — generates the Prisma
   Client against the same Alpine/musl target the container runs on, compiles `src/` → `dist/` via
   `nest build`, then strips devDependencies.
3. `production` stage: copies `node_modules`, `dist`, and `prisma` (needed for `migrate deploy` and the
   Prisma Client's schema/engine files) into a clean image, runs as the non-root `node` user.

`prisma` is a `dependencies` entry (not `devDependencies`) specifically so it survives
`npm prune --omit=dev` and remains available for the Pre-Deploy Command above. No secrets are baked
into the image — every credential is read from `process.env` at runtime only.

## Required environment variables

None of the following have a default in `env.validation.ts` — the app will not boot without all of
them set in Render.

### Public (not secret)

| Variable | Purpose | Value source |
|---|---|---|
| `NODE_ENV` | `production` — disables Swagger UI, sets `secure`/`SameSite=None` cookies, production log level | you set it to `production` |
| `PORT` | HTTP listen port | **do not set** — Render injects this automatically; `src/main.ts` already calls `app.listen(configService.get('port'))` which reads `process.env.PORT` |
| `APP_URL` | Base URL used to build links inside verification/password-reset emails (`src/integrations/email/email.service.ts`: `` `${appUrl}/auth/verify-email?token=...` ``) | **Your frontend's public URL** — despite the name, this is not the backend's own Render URL, since the link is served by the frontend's `/auth/verify-email` route |
| `FRONTEND_URL` | CORS `origin` (`src/main.ts` `app.enableCors`) and WebSocket CORS (`src/common/adapters/socket-io.adapter.ts`) | Your deployed frontend's exact origin — must match exactly (scheme + host, no trailing slash) |
| `API_PREFIX` | Global route prefix | optional, defaults to `api/v1` |

### Secrets

| Variable | Purpose | Value source |
|---|---|---|
| `DATABASE_URL` | Postgres connection (`prisma/schema.prisma`: `provider = "postgresql"`, `url = env("DATABASE_URL")`) | Render PostgreSQL's Internal Connection String (same region/account as this service), or an external provider (Neon, Supabase, RDS) |
| `REDIS_URL` | BullMQ queue connection, connected **eagerly at boot** (`src/jobs/queue.module.ts`), also backs `ThrottlerModule` rate-limit storage | Render Key Value, or an external provider (Upstash, ElastiCache) |
| `JWT_SECRET` | Signs access-token JWTs (`src/auth/auth.module.ts`, `src/auth/strategies/jwt.strategy.ts`) | Generate a random 32+ byte value (e.g. `openssl rand -hex 32`) — Render's "Generate" button works too |
| `JWT_REFRESH_SECRET` | Required by schema; refresh tokens are actually opaque, DB-hashed random tokens (`src/auth/token.service.ts`), not JWTs — still must be a distinct strong value | Generate separately from `JWT_SECRET` |
| `COOKIE_SECRET` | Signs the `access_token`/`refresh_token` cookies (`cookie-parser`, wired in `src/main.ts`) | Generate separately, 32+ bytes |
| `STORAGE_ENDPOINT` | S3-compatible endpoint URL (`src/storage/storage.service.ts` → `@aws-sdk/client-s3`) — vendor-agnostic: AWS S3, Cloudflare R2, MinIO, Backblaze B2 all work | Your chosen S3-compatible provider's endpoint |
| `STORAGE_BUCKET` | Bucket name for uploaded business documents | Must already exist, must **not** be publicly readable — the app only ever returns signed URLs |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | Credentials for the bucket above | Your storage provider's IAM/API key pair |

### Optional (safe defaults exist — see `.env.example` for the full list)

`JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `STORAGE_REGION`, `STORAGE_FORCE_PATH_STYLE`,
`STORAGE_SIGNED_URL_TTL_SECONDS`, `EMAIL_PROVIDER`/`EMAIL_API_KEY`/`EMAIL_FROM`,
`AI_PROVIDER`/`AI_API_KEY`/`AI_MODEL`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`,
`GOOGLE_CLIENT_ID`, `THROTTLE_TTL_SECONDS`/`THROTTLE_LIMIT`.

## Prisma migrations

Migrations in `prisma/migrations/` are additive-only (verified — no `DROP TABLE`/`DROP COLUMN`/
`TRUNCATE`/`DELETE` in any migration file). Apply them with:

```
npx prisma migrate deploy
```

set as Render's **Pre-Deploy Command**, so it runs against the new image with real `DATABASE_URL`
before traffic switches to it. Never run `prisma migrate reset` or `prisma db push` against
production — this project already uses tracked migrations, so `db push` would drift the migration
history.

## Health check

- `GET /api/v1/health` — liveness only (`{ status: 'ok' }`), no secrets, no dependency checks. Use this
  as Render's Health Check Path.
- `GET /api/v1/ready` — readiness, pings Postgres via `@nestjs/terminus`. Useful for your own
  monitoring, but a transient DB blip shouldn't restart the whole container, so liveness stays on `/health`.

## What CANNOT be fixed by a GitHub commit

Once this document and `.env.example` are correct, the remaining "Invalid environment configuration"
error is **entirely** a matter of entering the variables above into Render's dashboard with real
values from real provisioned services (Postgres, Redis, an S3-compatible bucket). No further code
change makes the app boot without them — that would require weakening validation, which this project
deliberately does not do.
