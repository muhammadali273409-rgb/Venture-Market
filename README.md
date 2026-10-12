# VentureMarket Backend

Production-oriented backend for VentureMarket — a marketplace for buying and selling startups. Built with **NestJS + TypeScript + PostgreSQL (Prisma) + Redis (BullMQ) + S3-compatible object storage**.

This is a real, running backend: a relational schema with 40+ models, transactional business logic (offer acceptance, deal creation), object-level authorization on every protected route, private document storage with signed URLs and audit logging, and background job processing — not a mock API.

See also: [ARCHITECTURE.md](./ARCHITECTURE.md) · [DATABASE.md](./DATABASE.md) · [API.md](./API.md) · [SECURITY.md](./SECURITY.md) · [AI.md](./AI.md) · [DEPLOYMENT.md](./DEPLOYMENT.md)

## Stack

- **Runtime:** Node.js 20+, TypeScript (strict mode)
- **Framework:** NestJS 10 (Express platform)
- **Database:** PostgreSQL 16+ via Prisma ORM
- **Cache / Queues:** Redis via BullMQ
- **Realtime:** Socket.IO (notification push)
- **Object storage:** any S3-compatible provider (AWS S3, Cloudflare R2, MinIO)
- **Auth:** JWT access tokens + rotating opaque refresh tokens, Argon2id password hashing
- **Validation:** class-validator / class-transformer + Zod (env, AI output)
- **Docs:** OpenAPI/Swagger at `/docs` (non-production only)

## Getting started

### 1. Prerequisites

- Node.js 20+
- A PostgreSQL 16+ database
- A Redis instance
- (Optional for document uploads) an S3-compatible bucket — MinIO works for local dev

### 2. Configure environment

```bash
cp .env.example .env
# fill in DATABASE_URL, REDIS_URL, and generate long random secrets for
# JWT_SECRET / JWT_REFRESH_SECRET / COOKIE_SECRET
```

The app **fails fast at startup** if required env vars are missing or malformed (`src/config/env.validation.ts`) — see SECURITY.md.

### 3. Install & migrate

```bash
npm install
npm run prisma:migrate      # creates the database schema
npm run prisma:seed         # optional: seed categories, plans, and 3 demo accounts
```

Seed accounts (development only, clearly tagged, **never reuse in production**):

| Role   | Email                                        | Password             |
|--------|-----------------------------------------------|-----------------------|
| Seller | `seller+venturemarket-seed@example.com`      | `Passw0rd!Seed123`    |
| Buyer  | `buyer+venturemarket-seed@example.com`       | `Passw0rd!Seed123`    |
| Admin  | `admin+venturemarket-seed@example.com`       | `Passw0rd!Seed123`    |

### 4. Run

```bash
npm run start:dev     # API + all BullMQ processors, on http://localhost:3000
```

Or with Docker Compose (Postgres + Redis + MinIO + backend):

```bash
docker compose up --build
```

Swagger UI: `http://localhost:3000/docs` (development/test only — disabled in production).
Health checks: `GET /live` (liveness, unprefixed — Render health check path), `GET /api/v1/health` (liveness), `GET /api/v1/ready` (readiness, pings the DB).

### 5. Test

```bash
npm run typecheck
npm test              # unit tests — no external services required
npm run test:e2e      # integration tests — requires a live Postgres + Redis (point .env at a disposable DB)
```

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full module map and request flow (`Controller → Guard/Validation → Service → Prisma → PostgreSQL`).

## What's implemented vs. deferred

This backend implements the full **MVP** critical path end-to-end (auth → business → listing → search → watchlist → messaging → offers/negotiation → deal room → due diligence → private documents → notifications → admin moderation), plus the V2 surface (AI analysis, verification, billing/subscriptions, transactions/webhooks) with real, working logic rather than stubs. A few things are deliberately scoped down for a first pass — see the "Known limitations" section of [ARCHITECTURE.md](./ARCHITECTURE.md).
