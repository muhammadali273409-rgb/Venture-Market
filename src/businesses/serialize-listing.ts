import { BusinessListing } from '@prisma/client';
import { toMajorUnits } from '../common/utils/money';

const toMajor = (minor: bigint | null | undefined) => (minor == null ? null : toMajorUnits(minor));

/**
 * BigInt minor-unit columns can't be JSON-serialized (JSON.stringify throws),
 * so every listing row leaving the API goes through here: money becomes
 * plain major-unit numbers, and a missing figure stays null.
 */
export function serializeListing(listing: BusinessListing) {
  const { askingPriceMinor, monthlyRevenueMinor, monthlyProfitMinor, ...rest } = listing;
  return {
    ...rest,
    askingPrice: toMajor(askingPriceMinor),
    monthlyRevenue: toMajor(monthlyRevenueMinor),
    monthlyProfit: toMajor(monthlyProfitMinor),
  };
}
