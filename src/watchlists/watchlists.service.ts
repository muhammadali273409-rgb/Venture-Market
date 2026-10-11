import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { serializeListing } from '../businesses/serialize-listing';

@Injectable()
export class WatchlistsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const items = await this.prisma.watchlist.findMany({
      where: { userId },
      include: { business: { include: { listing: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // Listing money columns are BigInt, which JSON can't serialize.
    return items.map((item) => ({
      ...item,
      business: {
        ...item.business,
        listing: item.business.listing ? serializeListing(item.business.listing) : null,
      },
    }));
  }

  async add(userId: string, businessId: string) {
    return this.prisma.watchlist.upsert({
      where: { userId_businessId: { userId, businessId } },
      create: { userId, businessId },
      update: {},
    });
  }

  async remove(userId: string, businessId: string) {
    await this.prisma.watchlist.deleteMany({ where: { userId, businessId } });
    return { success: true };
  }
}
