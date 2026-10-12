# Deployment

## Local development

```bash
cp .env.example .env   # fill in secrets
npm install
npm run prisma:migrate
npm run prisma:seed    # optional
npm run start:dev
```

Or via Docker Compose (Postgres + Redis + MinIO + backend, hot-reloading):

```bash
docker compose up --build
```

## Production build

```bash
npm ci
npm run prisma:generate
npm run build            # tsc via nest build → dist/
npm run prisma:migrate:deploy   # apply migrations — no interactive prompts, safe for CI
node dist/main.js
```

The multi-stage `Dockerfile` builds a minimal production image (`node:22-alpine`, `npm prune --omit=dev`,
runs as the non-root `node` user).

## Required infrastructure

| Component | Purpose | Notes |
|---|---|---|
| PostgreSQL 16+ | primary datastore | connection pooling recommended (PgBouncer/RDS Proxy) at scale |
| Redis | BullMQ queues, rate-limit/throttle storage | a managed Redis (ElastiCache/Upstash) is fine |
| S3-compatible bucket | private document storage | must **not** be publicly readable — signed URLs only |
| SMTP/email API | transactional email | swap `EmailProvider` implementation; console provider logs only |

## Scaling out the worker

`npm run start:dev`/`start:prod` currently run the HTTP API and all BullMQ processors
(`EmailProcessor`, `AiProcessor`, `SavedSearchProcessor`) in the same process — fine for MVP traffic.
To split them: run `node dist/jobs/worker.js` as a separate deployment (it bootstraps the same
`AppModule`, which is where the `@Processor()` classes are registered, without starting the HTTP
listener), and stop registering processors in the API deployment once queue volume justifies it.

## Environment variables

See `.env.example` for the full list with inline documentation. The app validates all of them at
startup (`src/config/env.validation.ts`) and **refuses to boot** if any required variable is missing
or malformed — this is intentional; do not work around it by making validation lenient.

### Render: required variables

None of these have a default — the app will not boot without them. Render does not read `.env`;
set these under **Environment → Environment Variables** on the web service. Use Render's "Generate"
option for the three `*_SECRET` values.

| Variable | Secret? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Render PostgreSQL connection string (Internal URL if the DB is on the same Render account/region) |
| `REDIS_URL` | yes | required eagerly at boot — `QueueModule` (BullMQ, `src/jobs/queue.module.ts`) connects on startup, not lazily |
| `APP_URL` | no | base URL used to build the **frontend** links sent in verification/reset emails (`${APP_URL}/auth/verify-email?token=...`) — set this to the frontend's URL, not the backend's own Render URL |
| `FRONTEND_URL` | no | used for CORS `origin` (`src/main.ts`) — must exactly match the deployed frontend's origin |
| `JWT_SECRET` | yes | signs access tokens (`JwtModule`, `JwtStrategy`) — min 16 chars |
| `JWT_REFRESH_SECRET` | yes | validated at boot but not currently used to sign anything — refresh tokens are opaque, DB-hashed (`src/auth/token.service.ts`), not JWTs. Still required by the schema; use a distinct strong value |
| `COOKIE_SECRET` | yes | signs the `access_token`/`refresh_token` cookies (`cookie-parser`, `src/main.ts`) — min 16 chars |
| `STORAGE_ENDPOINT` | no | S3-compatible endpoint (`StorageService`, `@aws-sdk/client-s3`) — any provider works: AWS S3, Cloudflare R2, MinIO, etc. |
| `STORAGE_BUCKET` | no | bucket name, must already exist and not be publicly readable |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | yes | credentials for the bucket above |

`PORT` is provided automatically by Render — do not set it manually; the app already reads
`process.env.PORT` (default `3000`) via `src/main.ts`.

## Health checks

- `GET /live` — liveness at the root, outside `API_PREFIX`, no DB check. **Use this as Render's Health Check Path.**
- `GET /api/v1/health` — liveness (process is up)
- `GET /api/v1/ready` — readiness (pings PostgreSQL via `@nestjs/terminus`)

Point your orchestrator's liveness probe at `/health` and readiness probe at `/ready`.

## Database backups & disaster recovery

Not automated by this codebase — this is infrastructure-level, not application-level:

- **Backup frequency:** take continuous WAL archiving + daily full snapshots if self-hosting Postgres;
  managed providers (RDS, Neon, Supabase) provide this out of the box — enable point-in-time recovery.
- **Restore procedure:** restore the snapshot to a new instance, verify against `prisma migrate status`
  before repointing `DATABASE_URL`; never restore directly over a live production database without a
  verified snapshot of the *current* state taken first.
- **Recovery targets:** define an explicit RPO/RTO with the team before go-live; this determines backup
  frequency and whether WAL archiving (near-zero RPO) is required versus daily snapshots.

## Observability

- Structured JSON logs via `nestjs-pino` (pretty-printed in development only), with request-id
  correlation and automatic secret redaction — ship stdout to your log aggregator of choice.
- `AuditLog` (immutable, queryable via `/admin/audit-logs`) covers security-relevant application events;
  it is not a substitute for infrastructure-level logging/metrics/tracing, which should be layered on
  top in production (e.g. OpenTelemetry auto-instrumentation for Nest/Prisma/BullMQ).
