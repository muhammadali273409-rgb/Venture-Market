import { Injectable } from '@nestjs/common';
import {
  BusinessStatus,
  ListingStatus,
  NegotiationStatus,
  Offer,
  OfferStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ErrorCode } from '../common/constants/error-codes';
import {
  ConflictAppException,
  ForbiddenAppException,
  NotFoundAppException,
} from '../common/errors/app.exception';
import { toMinorUnits, toMajorUnits } from '../common/utils/money';
import { CreateOfferDto } from './dto/create-offer.dto';
import { CounterOfferDto } from './dto/counter-offer.dto';

const OPEN_OFFER_STATUSES: OfferStatus[] = [
  OfferStatus.SUBMITTED,
  OfferStatus.VIEWED,
  OfferStatus.COUNTERED,
];

@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async create(user: AuthenticatedUser, businessId: string, dto: CreateOfferDto) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: { listing: true },
    });

    if (!business || business.deletedAt || business.status !== BusinessStatus.PUBLISHED) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }
    if (business.ownerId === user.id) {
      throw new ForbiddenAppException(
        ErrorCode.OFFER_NOT_ALLOWED,
        'You cannot make an offer on your own business',
      );
    }
    const expiresAt = this.parseExpiry(dto.expiresAt);

    let negotiation = await this.prisma.negotiation.findFirst({
      where: { businessId, buyerId: user.id, status: NegotiationStatus.OPEN },
    });

    if (negotiation) {
      const openOffer = await this.prisma.offer.findFirst({
        where: { negotiationId: negotiation.id, status: { in: OPEN_OFFER_STATUSES } },
      });
      if (openOffer) {
        throw new ConflictAppException(
          ErrorCode.OFFER_NOT_ALLOWED,
          'You already have an open offer on this business — respond to it or withdraw it first',
        );
      }
    } else {
      negotiation = await this.prisma.negotiation.create({
        data: {
          businessId,
          buyerId: user.id,
          sellerId: business.ownerId,
          status: NegotiationStatus.OPEN,
        },
      });
    }

    const amountMinor = toMinorUnits(dto.amount);
    const currency = dto.currency ?? business.listing?.currency ?? 'USD';

    const offer = await this.prisma.offer.create({
      data: {
        negotiationId: negotiation.id,
        businessId,
        buyerId: user.id,
        sellerId: business.ownerId,
        amountMinor,
        currency,
        terms: dto.terms,
        message: dto.message,
        expiresAt,
        status: OfferStatus.SUBMITTED,
        createdById: user.id,
        submittedAt: new Date(),
        revisions: {
          create: {
            amountMinor,
            currency,
            terms: dto.terms,
            status: OfferStatus.SUBMITTED,
            submittedById: user.id,
          },
        },
      },
    });

    await this.notificationsService.create({
      userId: business.ownerId,
      type: 'NEW_OFFER',
      title: `New offer on ${business.name}`,
      metadata: { businessId, offerId: offer.id },
    });

    await this.auditService.record({
      userId: user.id,
      action: 'OFFER_CREATED',
      targetType: 'Offer',
      targetId: offer.id,
      metadata: { businessId, amount: dto.amount, currency },
    });

    return this.serializeOffer(offer);
  }

  async listForUser(user: AuthenticatedUser) {
    const offers = await this.prisma.offer.findMany({
      where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
      orderBy: { createdAt: 'desc' },
      include: { business: { select: { id: true, name: true, slug: true } } },
    });
    return offers.map((offer) => this.serializeOffer(offer));
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const offer = await this.getParticipantOffer(user, id);
    const full = await this.prisma.offer.findUnique({
      where: { id: offer.id },
      include: { revisions: { orderBy: { createdAt: 'asc' } } },
    });
    return full ? this.serializeOffer(full) : full;
  }

  /**
   * BigInt minor-unit columns (amountMinor) can't be JSON-serialized as-is —
   * convert them to plain numbers before returning, on both the offer and
   * any nested revisions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeOffer(offer: any) {
    return {
      ...offer,
      amount: toMajorUnits(offer.amountMinor),
      amountMinor: undefined,
      revisions: offer.revisions
        ? offer.revisions.map((r: { amountMinor: bigint }) => ({
            ...r,
            amount: toMajorUnits(r.amountMinor),
            amountMinor: undefined,
          }))
        : undefined,
    };
  }

  async counter(user: AuthenticatedUser, offerId: string, dto: CounterOfferDto) {
    const parent = await this.getParticipantOffer(user, offerId);

    if (!OPEN_OFFER_STATUSES.includes(parent.status)) {
      throw new ConflictAppException(
        ErrorCode.OFFER_INVALID_STATE_TRANSITION,
        'This offer can no longer be countered',
      );
    }
    if (parent.createdById === user.id) {
      throw new ForbiddenAppException(
        ErrorCode.OFFER_NOT_ALLOWED,
        'Wait for the other party to respond',
      );
    }
    await this.assertNotExpired(parent);
    const expiresAt = this.parseExpiry(dto.expiresAt);

    const amountMinor = toMinorUnits(dto.amount);
    const counterpartyId = user.id === parent.buyerId ? parent.sellerId : parent.buyerId;

    const newOffer = await this.prisma.$transaction(async (tx) => {
      // Conditional on the parent still being open, so two concurrent responses can't both land.
      const parentUpdate = await tx.offer.updateMany({
        where: { id: parent.id, status: { in: OPEN_OFFER_STATUSES } },
        data: { status: OfferStatus.COUNTERED, respondedAt: new Date() },
      });
      if (parentUpdate.count === 0) {
        throw new ConflictAppException(
          ErrorCode.OFFER_INVALID_STATE_TRANSITION,
          'This offer can no longer be countered',
        );
      }
      return tx.offer.create({
        data: {
          negotiationId: parent.negotiationId,
          businessId: parent.businessId,
          buyerId: parent.buyerId,
          sellerId: parent.sellerId,
          parentOfferId: parent.id,
          amountMinor,
          currency: dto.currency ?? parent.currency,
          terms: dto.terms,
          message: dto.message,
          expiresAt,
          status: OfferStatus.SUBMITTED,
          createdById: user.id,
          submittedAt: new Date(),
          revisions: {
            create: {
              amountMinor,
              currency: dto.currency ?? parent.currency,
              terms: dto.terms,
              status: OfferStatus.SUBMITTED,
              submittedById: user.id,
            },
          },
        },
      });
    });

    await this.notificationsService.create({
      userId: counterpartyId,
      type: 'COUNTER_OFFER',
      title: 'You received a counter-offer',
      metadata: { offerId: newOffer.id },
    });
    await this.auditService.record({
      userId: user.id,
      action: 'OFFER_COUNTERED',
      targetType: 'Offer',
      targetId: newOffer.id,
      metadata: { parentOfferId: parent.id, amount: dto.amount },
    });

    return this.serializeOffer(newOffer);
  }

  async reject(user: AuthenticatedUser, offerId: string) {
    const offer = await this.getParticipantOffer(user, offerId);
    if (offer.createdById === user.id) {
      throw new ForbiddenAppException(
        ErrorCode.OFFER_NOT_ALLOWED,
        'You cannot reject your own offer — withdraw it instead',
      );
    }

    const result = await this.prisma.offer.updateMany({
      where: { id: offer.id, status: { in: OPEN_OFFER_STATUSES } },
      data: { status: OfferStatus.REJECTED, respondedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictAppException(
        ErrorCode.OFFER_INVALID_STATE_TRANSITION,
        'Offer cannot be rejected in its current state',
      );
    }

    await this.prisma.negotiation.update({
      where: { id: offer.negotiationId },
      data: { status: NegotiationStatus.REJECTED },
    });

    const counterpartyId = user.id === offer.buyerId ? offer.sellerId : offer.buyerId;
    await this.notificationsService.create({
      userId: counterpartyId,
      type: 'OFFER_REJECTED',
      title: 'Your offer was rejected',
      metadata: { offerId: offer.id },
    });
    await this.auditService.record({
      userId: user.id,
      action: 'OFFER_REJECTED',
      targetType: 'Offer',
      targetId: offer.id,
    });

    return { success: true };
  }

  async withdraw(user: AuthenticatedUser, offerId: string) {
    const offer = await this.getParticipantOffer(user, offerId);
    if (offer.createdById !== user.id) {
      throw new ForbiddenAppException(
        ErrorCode.OFFER_NOT_ALLOWED,
        'You can only withdraw your own offer',
      );
    }

    const result = await this.prisma.offer.updateMany({
      where: { id: offer.id, status: { in: OPEN_OFFER_STATUSES } },
      data: { status: OfferStatus.WITHDRAWN, respondedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictAppException(
        ErrorCode.OFFER_INVALID_STATE_TRANSITION,
        'Offer cannot be withdrawn in its current state',
      );
    }

    await this.prisma.negotiation.update({
      where: { id: offer.negotiationId },
      data: { status: NegotiationStatus.WITHDRAWN },
    });

    const counterpartyId = user.id === offer.buyerId ? offer.sellerId : offer.buyerId;
    await this.notificationsService.create({
      userId: counterpartyId,
      type: 'DEAL_UPDATE',
      title: 'An offer was withdrawn',
      metadata: { offerId: offer.id },
    });
    await this.auditService.record({
      userId: user.id,
      action: 'OFFER_WITHDRAWN',
      targetType: 'Offer',
      targetId: offer.id,
    });

    return { success: true };
  }

  /**
   * Accepting an offer is the single most concurrency-sensitive operation in
   * the platform: two buyers must never both succeed in acquiring the same
   * business. We use an atomic conditional UPDATE (status IN (...) WHERE)
   * inside a transaction — Postgres row-locks the row for the duration of the
   * UPDATE, so a losing concurrent request sees `count === 0` and fails
   * cleanly instead of racing past a stale read.
   */
  async accept(user: AuthenticatedUser, offerId: string) {
    const offer = await this.getParticipantOffer(user, offerId);
    if (offer.createdById === user.id) {
      throw new ForbiddenAppException(
        ErrorCode.OFFER_NOT_ALLOWED,
        'You cannot accept your own offer',
      );
    }
    await this.assertNotExpired(offer);

    const deal = await this.prisma.$transaction(async (tx) => {
      const acceptResult = await tx.offer.updateMany({
        where: { id: offer.id, status: { in: [OfferStatus.SUBMITTED, OfferStatus.VIEWED] } },
        data: { status: OfferStatus.ACCEPTED, respondedAt: new Date() },
      });
      if (acceptResult.count === 0) {
        throw new ConflictAppException(
          ErrorCode.OFFER_ALREADY_ACCEPTED,
          'This offer is no longer available to accept',
        );
      }

      // The listing comes off the market for the life of the deal. It only
      // becomes SOLD when the deal completes (DealsService); if the deal is
      // cancelled the seller can resume it.
      const businessUpdate = await tx.business.updateMany({
        where: { id: offer.businessId, status: BusinessStatus.PUBLISHED },
        data: { status: BusinessStatus.PAUSED },
      });
      if (businessUpdate.count === 0) {
        throw new ConflictAppException(
          ErrorCode.OFFER_ALREADY_ACCEPTED,
          'This business already has an accepted offer',
        );
      }

      await tx.businessListing.update({
        where: { businessId: offer.businessId },
        data: { status: ListingStatus.UNPUBLISHED },
      });

      await tx.negotiation.update({
        where: { id: offer.negotiationId },
        data: { status: NegotiationStatus.ACCEPTED },
      });

      // Any other open negotiations for this business are now moot.
      await tx.negotiation.updateMany({
        where: {
          businessId: offer.businessId,
          status: NegotiationStatus.OPEN,
          id: { not: offer.negotiationId },
        },
        data: { status: NegotiationStatus.EXPIRED },
      });
      await tx.offer.updateMany({
        where: {
          businessId: offer.businessId,
          status: { in: OPEN_OFFER_STATUSES },
          id: { not: offer.id },
        },
        data: { status: OfferStatus.EXPIRED, respondedAt: new Date() },
      });

      const createdDeal = await tx.deal.create({
        data: {
          businessId: offer.businessId,
          negotiationId: offer.negotiationId,
          acceptedOfferId: offer.id,
          buyerId: offer.buyerId,
          sellerId: offer.sellerId,
          participants: {
            create: [
              { userId: offer.buyerId, role: 'BUYER' },
              { userId: offer.sellerId, role: 'SELLER' },
            ],
          },
          timelineEvents: {
            create: {
              type: 'OFFER_ACCEPTED',
              actorId: user.id,
              metadata: { offerId: offer.id } as Prisma.InputJsonValue,
            },
          },
        },
      });

      return createdDeal;
    });

    const counterpartyId = user.id === offer.buyerId ? offer.sellerId : offer.buyerId;
    await this.notificationsService.create({
      userId: counterpartyId,
      type: 'OFFER_ACCEPTED',
      title: 'Your offer was accepted! A deal room has been created.',
      metadata: { offerId: offer.id, dealId: deal.id },
    });
    await this.auditService.record({
      userId: user.id,
      action: 'OFFER_ACCEPTED',
      targetType: 'Offer',
      targetId: offer.id,
      metadata: { dealId: deal.id },
    });

    return deal;
  }

  private parseExpiry(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const expiresAt = new Date(value);
    if (expiresAt.getTime() <= Date.now()) {
      throw new ConflictAppException(ErrorCode.VALIDATION_ERROR, 'expiresAt must be in the future');
    }
    return expiresAt;
  }

  /** Lazily expires an offer whose deadline has passed, then refuses to act on it. */
  private async assertNotExpired(offer: Offer): Promise<void> {
    if (!offer.expiresAt || offer.expiresAt.getTime() > Date.now()) return;
    await this.prisma.offer.updateMany({
      where: { id: offer.id, status: { in: OPEN_OFFER_STATUSES } },
      data: { status: OfferStatus.EXPIRED },
    });
    throw new ConflictAppException(ErrorCode.OFFER_EXPIRED, 'This offer has expired');
  }

  private async getParticipantOffer(user: AuthenticatedUser, offerId: string): Promise<Offer> {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer || (offer.buyerId !== user.id && offer.sellerId !== user.id)) {
      throw new NotFoundAppException(ErrorCode.OFFER_NOT_FOUND, 'Offer not found');
    }
    return offer;
  }
}
