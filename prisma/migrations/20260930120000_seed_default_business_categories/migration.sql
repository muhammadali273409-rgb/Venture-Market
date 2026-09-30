-- Data migration: default business categories.
-- Idempotent: ON CONFLICT DO NOTHING skips any row whose name or slug already
-- exists, so this is safe to re-run manually (e.g. via `prisma db execute`).
-- gen_random_uuid() is built into PostgreSQL 13+.
INSERT INTO "business_categories" ("id", "name", "slug")
VALUES
    (gen_random_uuid()::text, 'Technology', 'technology'),
    (gen_random_uuid()::text, 'Retail', 'retail'),
    (gen_random_uuid()::text, 'Food & Beverage', 'food-beverage'),
    (gen_random_uuid()::text, 'Fashion', 'fashion'),
    (gen_random_uuid()::text, 'Services', 'services'),
    (gen_random_uuid()::text, 'Healthcare', 'healthcare'),
    (gen_random_uuid()::text, 'Education', 'education'),
    (gen_random_uuid()::text, 'Finance', 'finance'),
    (gen_random_uuid()::text, 'Real Estate', 'real-estate'),
    (gen_random_uuid()::text, 'Other', 'other')
ON CONFLICT DO NOTHING;
