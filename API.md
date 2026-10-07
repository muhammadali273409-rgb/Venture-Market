# API

Base URL: `/api/v1`. Full interactive reference (dev/test only): `GET /docs` (Swagger UI).

## Conventions

**Success:**
```json
{ "data": { } }
```

**Paginated (cursor-based):**
```json
{ "data": [ ], "pagination": { "nextCursor": "abc123", "hasMore": true } }
```
Request the next page with `?cursor=<nextCursor>`. `limit` is capped at 100 (default 20–50 depending on endpoint).

**Error:**
```json
{ "error": { "code": "BUSINESS_NOT_FOUND", "message": "Business not found" }, "requestId": "..." }
```
Error codes are centralized in `src/common/constants/error-codes.ts`. Stack traces are never returned
to clients (`HttpExceptionFilter` logs them server-side only).

**Auth:** JWT access token, sent either as `Authorization: Bearer <token>` or an httpOnly `access_token`
cookie (set automatically by `/auth/login` and `/auth/refresh`). Refresh tokens are httpOnly, path-scoped
to `/api/v1/auth`, and rotated on every use.

## Endpoint groups

| Group | Base path | Notes |
|---|---|---|
| Auth | `/auth` | register, login, logout, refresh, verify-email, forgot/reset-password, me |
| Users | `/users` | self profile update, public profile read |
| Organizations | `/organizations` | create, list own, member management (OWNER/ADMIN only) |
| Categories | `/categories` | public read, admin write |
| Businesses | `/businesses` | owner-scoped CRUD, listing sub-resource, metrics, publish/unpublish |
| Listings | `/listings` | **public** marketplace search + detail (published + public only) |
| Verification | `/businesses/:id/verification`, `/verification/:id/review` | submit (owner), review (admin/moderator) |
| Watchlist | `/watchlist`, `/businesses/:id/watchlist` | per-user |
| Saved searches | `/saved-searches` | stores validated `SearchListingsDto` filters |
| Offers | `/businesses/:id/offers`, `/offers/:id/{counter,accept,reject,withdraw}` | transactional accept → Deal |
| Conversations | `/conversations`, `/conversations/:id/messages` | membership-checked |
| Notifications | `/notifications` | list, mark read/read-all; realtime push via Socket.IO `/realtime` namespace |
| Documents | `/businesses/:id/documents`, `/documents/:id/*` | upload, signed download, access grant/revoke |
| Deals | `/deals`, `/deals/:id/*` | participants, tasks, status transitions, timeline |
| Due diligence | `/deals/:dealId/due-diligence` | requests + items, deal-scoped |
| Agreements | `/deals/:dealId/agreements` | versions + signatures |
| Transactions | `/deals/:dealId/transaction` | create (deal must be in `TRANSACTION` stage) |
| Billing | `/billing/plans`, `/billing/subscription`, `/billing/subscribe` | |
| AI | `/businesses/:id/ai-analysis`, `/ai-jobs/:id` | async job, rate-limited per plan |
| Reports | `/reports` | file + list own |
| Admin | `/admin/*` | ADMIN role only, every action written to `AdminAction` + `AuditLog` |
| Webhooks | `/webhooks/payment` | Stripe-style signature verification, idempotent |
| Health | `/health` (liveness), `/ready` (readiness — pings DB) | public |

## Seller projects → marketplace

A "project" is a `Business` + its `BusinessListing`, owned by `Business.ownerId` (the seller's `User.id`).

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/businesses` | SELLER, BUYER_SELLER | Creates a DRAFT. Accepts business fields plus `city`, `headline`, `askingPrice`, `currency` (USD/EUR/GBP), `annualRevenue` (stored as a REVENUE metric) |
| GET | `/businesses` | any signed-in user | The caller's own projects (with signed `images`) |
| GET | `/businesses/:id` | owner, ADMIN | 404 for anyone else |
| PATCH | `/businesses/:id` | owner, ADMIN | Business fields incl. `categoryId`, `city` |
| PATCH | `/businesses/:id/listing` | owner, ADMIN | `headline`, `askingPrice`, `currency`, `visibility` |
| POST | `/businesses/:id/images` | owner, ADMIN | multipart `file` (JPEG/PNG/WebP ≤5MB) + `kind` = `LOGO` \| `GALLERY`; one logo (replaced), ≤10 gallery images |
| DELETE | `/businesses/:id/images/:imageId` | owner, ADMIN | |
| POST | `/businesses/:id/publish` | owner, ADMIN | DRAFT/REJECTED/PENDING_REVIEW → PUBLISHED, live immediately (sets visibility PUBLIC unless UNLISTED). PAUSED → resumes. Requires name, description, category, business model, asking price (`409 LISTING_INCOMPLETE`) |
| POST | `/businesses/:id/unpublish` | owner, ADMIN | PUBLISHED → PAUSED, hidden from the marketplace |
| DELETE | `/businesses/:id` | owner, ADMIN | Soft delete. Seller: DRAFT/REJECTED/PAUSED only (unpublish first). Admin: any status. Refused while a deal is active |
| GET | `/listings` | public | PUBLISHED + PUBLIC, seller account active. Filters: `q` (text), `categoryId`, `city`, `country`, `sellerId`, `minPrice`/`maxPrice`, `minMrr`, `verified`; returns `seller`, `logoUrl`, `coverUrl`, `metrics` |
| GET | `/listings/:idOrSlug` | public | Same rules (UNLISTED also reachable by link); adds `description`, `images`, `verifications` |

Deleting accounts: `businesses.ownerId → users.id` is `ON DELETE RESTRICT`, so a seller who owns projects can't be
hard-deleted (their deals/offers history depends on them). Accounts are soft-deleted (`users.deletedAt`) or
SUSPENDED/DEACTIVATED, and the marketplace hides every project whose owner is in any of those states. Removing a
project row cascades to its listing, metrics, images and documents.

## Realtime

Socket.IO namespace `/realtime`. Connect with `{ auth: { token: <access_token> } }`; the gateway verifies
the JWT on connection and joins the socket to a `user:<id>` room. Event: `notification.new` (payload =
the created `Notification` row).

## Rate limits

Global default (configurable via `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT`), with stricter per-route
overrides on sensitive endpoints: `/auth/register` and `/auth/forgot-password`/`reset-password` (5/min),
`/auth/login` (10/min), `/auth/refresh` (20/min), offer mutations (30/min), messages (60/min), AI
analysis requests (10/min, **plus** a per-plan daily cap enforced in `AiService`), reports (10/min).
Exceeding a limit returns `429` (`RATE_LIMITED`-shaped via Nest's built-in throttler response).
