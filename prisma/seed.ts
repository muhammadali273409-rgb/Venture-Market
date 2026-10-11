import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { refreshListingFinancials } from '../src/businesses/listing-financials';

const prisma = new PrismaClient();

/**
 * Development-only seed data. Every seeded account uses the
 * `+venturemarket-seed` email tag and the fixed password below so they are
 * unmistakably identifiable as non-production accounts — never reuse these
 * credentials outside local development.
 */
const SEED_PASSWORD = 'Passw0rd!Seed123';

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

  const categories = await Promise.all(
    ['SaaS', 'AI', 'Mobile App', 'E-commerce', 'Marketplace', 'Agency', 'Newsletter', 'Developer Tool'].map((name) => {
      // Keyed by slug: migrations seed categories too (e.g. "E-Commerce" / e-commerce).
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      return prisma.businessCategory.upsert({ where: { slug }, create: { name, slug }, update: {} });
    }),
  );

  await Promise.all(
    [
      { code: 'FREE' as const, name: 'Free', priceMinor: 0n },
      { code: 'BUYER_PRO' as const, name: 'Buyer Pro', priceMinor: 4900n },
      { code: 'SELLER_PRO' as const, name: 'Seller Pro', priceMinor: 9900n },
      { code: 'BUSINESS' as const, name: 'Business', priceMinor: 29900n },
    ].map((plan) =>
      prisma.plan.upsert({
        where: { code: plan.code },
        create: { code: plan.code, name: plan.name, priceMinor: plan.priceMinor },
        update: {},
      }),
    ),
  );

  const seller = await prisma.user.upsert({
    where: { email: 'seller+venturemarket-seed@example.com' },
    create: {
      email: 'seller+venturemarket-seed@example.com',
      passwordHash,
      role: 'SELLER',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: 'Sasha', lastName: 'Seller', company: 'Acme SaaS Co.' } },
      notificationPreference: { create: {} },
    },
    update: {},
  });

  const buyer = await prisma.user.upsert({
    where: { email: 'buyer+venturemarket-seed@example.com' },
    create: {
      email: 'buyer+venturemarket-seed@example.com',
      passwordHash,
      role: 'BUYER',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: 'Bailey', lastName: 'Buyer' } },
      notificationPreference: { create: {} },
    },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: 'admin+venturemarket-seed@example.com' },
    create: {
      email: 'admin+venturemarket-seed@example.com',
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      profile: { create: { firstName: 'Ada', lastName: 'Admin' } },
      notificationPreference: { create: {} },
    },
    update: {},
  });

  const business = await prisma.business.upsert({
    where: { slug: 'acme-saas-analytics' },
    create: {
      ownerId: seller.id,
      name: 'Acme SaaS Analytics',
      slug: 'acme-saas-analytics',
      description: 'A profitable B2B analytics SaaS with 3 years of consistent MRR growth.',
      categoryId: categories[0].id,
      businessModel: 'B2B SaaS',
      foundedAt: new Date('2022-01-01'),
      country: 'US',
      website: 'https://example.com',
      status: 'PUBLISHED',
      listing: {
        create: {
          status: 'PUBLISHED',
          visibility: 'PUBLIC',
          askingPriceMinor: 45_000_00n,
          currency: 'USD',
          headline: 'Profitable analytics SaaS, $3.5k MRR, low churn',
          completenessScore: 100,
          publishedAt: new Date(),
        },
      },
      metrics: {
        create: [
          { metricType: 'MRR', valueMinor: 350_000n, currency: 'USD', period: new Date(), source: 'SELLER_PROVIDED' },
          { metricType: 'PROFIT', valueMinor: 200_000n, currency: 'USD', period: new Date(), source: 'SELLER_PROVIDED' },
          { metricType: 'GROWTH', valueMinor: 12_00n, currency: 'USD', period: new Date(), source: 'SELLER_PROVIDED' },
        ],
      },
    },
    update: {},
  });
  await refreshListingFinancials(prisma, business.id);

  await prisma.watchlist.upsert({
    where: { userId_businessId: { userId: buyer.id, businessId: business.id } },
    create: { userId: buyer.id, businessId: business.id },
    update: {},
  });

  // eslint-disable-next-line no-console
  console.log('Seed complete. Seed accounts (password for all: %s):', SEED_PASSWORD);
  // eslint-disable-next-line no-console
  console.log('  seller+venturemarket-seed@example.com');
  // eslint-disable-next-line no-console
  console.log('  buyer+venturemarket-seed@example.com');
  // eslint-disable-next-line no-console
  console.log('  admin+venturemarket-seed@example.com');
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
