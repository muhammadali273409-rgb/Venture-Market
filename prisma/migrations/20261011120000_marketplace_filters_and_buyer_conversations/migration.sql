-- Marketplace filters + buyer/seller conversations.
--
-- 1. Snapshot the latest monthly revenue (MRR) and monthly profit (PROFIT)
--    metric onto the listing, so the marketplace can filter, sort and page on
--    them in SQL. Annual REVENUE is deliberately NOT converted into a monthly
--    figure — a listing without an MRR metric simply has no monthly revenue.
-- 2. Tie a buyer's enquiry thread to (business, buyer) so a buyer gets one
--    conversation per business instead of a new one per click.
-- 3. Seed the marketplace's own categories (the ones the category chips show).

-- ── 1. Listing financial snapshot ────────────────────────────────────────

ALTER TABLE "business_listings" ADD COLUMN     "monthlyProfitMinor" BIGINT,
ADD COLUMN     "monthlyProfitVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "monthlyRevenueMinor" BIGINT,
ADD COLUMN     "monthlyRevenueVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "business_listings_monthlyRevenueMinor_idx" ON "business_listings"("monthlyRevenueMinor");
CREATE INDEX "business_listings_monthlyProfitMinor_idx" ON "business_listings"("monthlyProfitMinor");
CREATE INDEX "business_listings_publishedAt_idx" ON "business_listings"("publishedAt");

-- Backfill from the latest metric of each type (latest period, then latest entry).
UPDATE "business_listings" AS l
SET "monthlyRevenueMinor" = m."valueMinor",
    "monthlyRevenueVerified" = (m."verificationStatus" = 'VERIFIED')
FROM (
    SELECT DISTINCT ON ("businessId") "businessId", "valueMinor", "verificationStatus"
    FROM "business_metrics"
    WHERE "metricType" = 'MRR'
    ORDER BY "businessId", "period" DESC, "createdAt" DESC
) AS m
WHERE m."businessId" = l."businessId";

UPDATE "business_listings" AS l
SET "monthlyProfitMinor" = m."valueMinor",
    "monthlyProfitVerified" = (m."verificationStatus" = 'VERIFIED')
FROM (
    SELECT DISTINCT ON ("businessId") "businessId", "valueMinor", "verificationStatus"
    FROM "business_metrics"
    WHERE "metricType" = 'PROFIT'
    ORDER BY "businessId", "period" DESC, "createdAt" DESC
) AS m
WHERE m."businessId" = l."businessId";

-- ── 2. Conversations ────────────────────────────────────────────────────

ALTER TABLE "conversations" ADD COLUMN     "buyerId" TEXT;

-- businessId was a bare column; drop references to rows that no longer exist
-- so the new foreign key can be created.
UPDATE "conversations"
SET "businessId" = NULL
WHERE "businessId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "businesses" b WHERE b."id" = "conversations"."businessId");

-- Existing two-person threads about a business between its owner and one
-- other user become that user's buyer thread. Only the oldest thread per
-- (business, buyer) is tagged, so the unique index below cannot fail.
WITH candidates AS (
    SELECT c."id",
           p."userId" AS "buyerId",
           ROW_NUMBER() OVER (PARTITION BY c."businessId", p."userId" ORDER BY c."createdAt", c."id") AS rn
    FROM "conversations" c
    JOIN "businesses" b ON b."id" = c."businessId"
    JOIN "conversation_participants" p ON p."conversationId" = c."id" AND p."userId" <> b."ownerId"
    WHERE EXISTS (
            SELECT 1 FROM "conversation_participants" o
            WHERE o."conversationId" = c."id" AND o."userId" = b."ownerId"
          )
      AND (SELECT COUNT(*) FROM "conversation_participants" x WHERE x."conversationId" = c."id") = 2
)
UPDATE "conversations" AS c
SET "buyerId" = candidates."buyerId"
FROM candidates
WHERE candidates."id" = c."id" AND candidates.rn = 1;

CREATE INDEX "conversations_businessId_idx" ON "conversations"("businessId");
CREATE UNIQUE INDEX "conversations_businessId_buyerId_key" ON "conversations"("businessId", "buyerId");

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Messages are always read newest-first within one conversation.
DROP INDEX "messages_conversationId_idx";
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- ── 3. Marketplace categories ────────────────────────────────────────────
-- The category chips on /marketplace. Idempotent: rows whose name or slug
-- already exist (e.g. "E-commerce" from the dev seed) are left untouched.

INSERT INTO "business_categories" ("id", "name", "slug")
VALUES
    (gen_random_uuid()::text, 'SaaS & AI', 'saas-ai'),
    (gen_random_uuid()::text, 'Developer Tools', 'developer-tools'),
    (gen_random_uuid()::text, 'FinTech & API', 'fintech-api'),
    (gen_random_uuid()::text, 'E-Commerce', 'e-commerce'),
    (gen_random_uuid()::text, 'Media & Newsletters', 'media-newsletters')
ON CONFLICT DO NOTHING;
