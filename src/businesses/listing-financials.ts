import { MetricType, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The marketplace filters and sorts on monthly revenue and monthly profit,
 * so the latest value of each is copied onto the listing
 * (monthlyRevenueMinor / monthlyProfitMinor). Business rules:
 *
 * - Monthly revenue is the latest MRR metric; monthly profit is the latest
 *   PROFIT metric. "Latest" = most recent period, then most recent entry.
 * - Annual REVENUE is never divided into a monthly figure, and revenue is
 *   never used as profit — a missing metric stays null ("not disclosed").
 * - The *Verified flags are true only when that exact metric was verified;
 *   seller-provided figures stay unverified.
 *
 * Call after any write to a business's metrics.
 */
export async function refreshListingFinancials(db: Db, businessId: string): Promise<void> {
  const [revenue, profit] = await Promise.all([
    latestMetric(db, businessId, 'MRR'),
    latestMetric(db, businessId, 'PROFIT'),
  ]);

  await db.businessListing.updateMany({
    where: { businessId },
    data: {
      monthlyRevenueMinor: revenue?.valueMinor ?? null,
      monthlyRevenueVerified: revenue?.verificationStatus === 'VERIFIED',
      monthlyProfitMinor: profit?.valueMinor ?? null,
      monthlyProfitVerified: profit?.verificationStatus === 'VERIFIED',
    },
  });
}

function latestMetric(db: Db, businessId: string, metricType: MetricType) {
  return db.businessMetric.findFirst({
    where: { businessId, metricType },
    orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
    select: { valueMinor: true, verificationStatus: true },
  });
}
