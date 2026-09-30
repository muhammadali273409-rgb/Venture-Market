import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Business, BusinessStatus, DealStatus, ListingStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from '../jobs/queue.constants';
import { uniqueSlug } from '../common/utils/slugify';
import { toMinorUnits, toMajorUnits } from '../common/utils/money';
import { StateMachine } from '../common/utils/state-machine';
import { ErrorCode } from '../common/constants/error-codes';
import {
  AppException,
  ConflictAppException,
  NotFoundAppException,
} from '../common/errors/app.exception';
import { HttpStatus } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { CreateMetricDto } from './dto/create-metric.dto';
import { UpdateListingDto } from './dto/update-listing.dto';

const businessStateMachine = new StateMachine<BusinessStatus>({
  DRAFT: ['PENDING_REVIEW', 'ARCHIVED'],
  PENDING_REVIEW: ['PUBLISHED', 'REJECTED', 'DRAFT'],
  PUBLISHED: ['PAUSED', 'SOLD', 'SUSPENDED', 'ARCHIVED'],
  // PAUSED -> SOLD: an accepted offer pauses the listing while the deal runs; completing the deal sells it.
  PAUSED: ['PUBLISHED', 'SOLD', 'ARCHIVED'],
  // A rejected listing can be fixed and resubmitted directly.
  REJECTED: ['DRAFT', 'PENDING_REVIEW'],
  SUSPENDED: ['PUBLISHED', 'ARCHIVED'],
  SOLD: ['ARCHIVED'],
  ARCHIVED: [],
});

/** Statuses in which the seller may no longer edit listing content or financials. */
const LOCKED_BUSINESS_STATUSES: BusinessStatus[] = [
  BusinessStatus.PENDING_REVIEW,
  BusinessStatus.SOLD,
  BusinessStatus.SUSPENDED,
  BusinessStatus.ARCHIVED,
];

/** Only never-approved businesses can be deleted by their seller. */
const DELETABLE_BUSINESS_STATUSES: BusinessStatus[] = [
  BusinessStatus.DRAFT,
  BusinessStatus.REJECTED,
];

export const ACTIVE_DEAL_STATUSES: DealStatus[] = [
  DealStatus.INITIATED,
  DealStatus.NDA,
  DealStatus.DUE_DILIGENCE,
  DealStatus.AGREEMENT,
  DealStatus.TRANSACTION,
  DealStatus.TRANSFER,
  DealStatus.DISPUTED,
];

const REQUIRED_LISTING_FIELDS = [
  'name',
  'description',
  'categoryId',
  'businessModel',
  'askingPrice',
] as const;

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectQueue(QUEUE_NAMES.SAVED_SEARCH_ALERTS) private readonly savedSearchQueue: Queue,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateBusinessDto): Promise<Business> {
    if (dto.organizationId) {
      const member = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: dto.organizationId, userId: user.id } },
      });
      if (!member) {
        throw new AppException(
          ErrorCode.AUTH_FORBIDDEN,
          'Not a member of this organization',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const business = await this.prisma.business.create({
      data: {
        ownerId: user.id,
        organizationId: dto.organizationId,
        name: dto.name,
        slug: uniqueSlug(dto.name),
        description: dto.description,
        categoryId: dto.categoryId,
        businessModel: dto.businessModel,
        foundedAt: dto.foundedAt ? new Date(dto.foundedAt) : undefined,
        country: dto.country,
        website: dto.website,
        status: BusinessStatus.DRAFT,
        listing: { create: { status: ListingStatus.DRAFT } },
      },
    });

    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_CREATED',
      targetType: 'Business',
      targetId: business.id,
    });

    return business;
  }

  async findOwned(user: AuthenticatedUser, id: string) {
    const business = await this.prisma.business.findUnique({
      where: { id },
      include: { listing: true, category: true, metrics: true },
    });

    if (!business || business.deletedAt || !this.canManage(user, business)) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }

    return this.serializeBusiness(business);
  }

  async listOwned(user: AuthenticatedUser) {
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: user.id, deletedAt: null },
      include: { listing: true },
      orderBy: { createdAt: 'desc' },
    });
    return businesses.map((business) => this.serializeBusiness(business));
  }

  /**
   * BigInt minor-unit columns (askingPriceMinor, valueMinor) can't be
   * JSON-serialized as-is — convert them to plain numbers before returning,
   * the same way the public listings endpoints already do.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeBusiness(business: any) {
    return {
      ...business,
      listing: business.listing ? this.serializeListing(business.listing) : business.listing,
      metrics: business.metrics
        ? business.metrics.map((m: any) => this.serializeMetric(m))
        : undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeListing(listing: any) {
    return {
      ...listing,
      askingPrice:
        listing.askingPriceMinor !== null ? toMajorUnits(listing.askingPriceMinor) : null,
      askingPriceMinor: undefined,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeMetric(metric: any) {
    return {
      ...metric,
      value: toMajorUnits(metric.valueMinor),
      valueMinor: undefined,
    };
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateBusinessDto) {
    const business = await this.findOwned(user, id);
    await this.assertEditable(business);
    return this.prisma.business.update({
      where: { id: business.id },
      data: {
        name: dto.name,
        description: dto.description,
        categoryId: dto.categoryId,
        businessModel: dto.businessModel,
        foundedAt: dto.foundedAt ? new Date(dto.foundedAt) : undefined,
        country: dto.country,
        website: dto.website,
      },
    });
  }

  async softDelete(user: AuthenticatedUser, id: string) {
    const business = await this.findOwned(user, id);
    if (!DELETABLE_BUSINESS_STATUSES.includes(business.status)) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_INVALID_STATE_TRANSITION,
        'Only draft or rejected businesses can be deleted — pause or archive a published listing instead',
      );
    }
    await this.prisma.business.update({
      where: { id: business.id },
      data: { deletedAt: new Date() },
    });
    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_DELETED',
      targetType: 'Business',
      targetId: business.id,
    });
    return { success: true };
  }

  async addMetric(user: AuthenticatedUser, businessId: string, dto: CreateMetricDto) {
    const business = await this.findOwned(user, businessId);
    await this.assertEditable(business);
    const metric = await this.prisma.businessMetric.create({
      data: {
        businessId: business.id,
        metricType: dto.metricType,
        valueMinor: toMinorUnits(dto.value),
        currency: dto.currency ?? 'USD',
        period: new Date(dto.period),
        source: 'SELLER_PROVIDED',
        verificationStatus: 'UNVERIFIED',
      },
    });
    return this.serializeMetric(metric);
  }

  async updateListing(user: AuthenticatedUser, businessId: string, dto: UpdateListingDto) {
    const business = await this.findOwned(user, businessId);
    await this.assertEditable(business);
    const listing = await this.prisma.businessListing.update({
      where: { businessId: business.id },
      data: {
        askingPriceMinor: dto.askingPrice !== undefined ? toMinorUnits(dto.askingPrice) : undefined,
        currency: dto.currency,
        headline: dto.headline,
        visibility: dto.visibility,
      },
    });
    return this.serializeListing(listing);
  }

  /**
   * Seller submits a DRAFT (or a fixed REJECTED) business for admin review.
   * Going live is exclusively AdminService.approveBusiness's job — a seller
   * can never move their own business to PUBLISHED from here.
   */
  async submitForReview(user: AuthenticatedUser, businessId: string) {
    const business = await this.findOwned(user, businessId);
    this.assertTransition(business.status, BusinessStatus.PENDING_REVIEW);

    const completeness = this.calculateCompleteness(business);
    if (completeness.score < 100) {
      throw new ConflictAppException(
        ErrorCode.LISTING_INCOMPLETE,
        `Listing is missing required fields: ${completeness.missing.join(', ')}`,
      );
    }

    const [updatedBusiness] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: { status: BusinessStatus.PENDING_REVIEW },
      }),
      this.prisma.businessListing.update({
        where: { businessId: business.id },
        data: { status: ListingStatus.PENDING_REVIEW, completenessScore: completeness.score },
      }),
    ]);

    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_SUBMITTED_FOR_REVIEW',
      targetType: 'Business',
      targetId: business.id,
    });

    return updatedBusiness;
  }

  /** Seller pulls a PENDING_REVIEW submission back to DRAFT to keep editing. */
  async withdrawSubmission(user: AuthenticatedUser, businessId: string) {
    const business = await this.findOwned(user, businessId);
    if (business.status !== BusinessStatus.PENDING_REVIEW) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_INVALID_STATE_TRANSITION,
        'Only a business that is pending review can be withdrawn',
      );
    }

    const [updatedBusiness] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: { status: BusinessStatus.DRAFT },
      }),
      this.prisma.businessListing.update({
        where: { businessId: business.id },
        data: { status: ListingStatus.DRAFT },
      }),
    ]);

    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_SUBMISSION_WITHDRAWN',
      targetType: 'Business',
      targetId: business.id,
    });

    return updatedBusiness;
  }

  /**
   * Resume a PAUSED listing. It was already approved, so it goes straight
   * back to PUBLISHED — unless a deal on it is still running.
   */
  async resume(user: AuthenticatedUser, businessId: string) {
    const business = await this.findOwned(user, businessId);
    if (business.status !== BusinessStatus.PAUSED) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_INVALID_STATE_TRANSITION,
        'Only a paused listing can be resumed',
      );
    }
    if (await this.hasActiveDeal(business.id)) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_LOCKED,
        'This business has an active deal and cannot be relisted',
      );
    }

    const [updatedBusiness] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: { status: BusinessStatus.PUBLISHED },
      }),
      this.prisma.businessListing.update({
        where: { businessId: business.id },
        data: { status: ListingStatus.PUBLISHED },
      }),
    ]);

    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_RESUMED',
      targetType: 'Business',
      targetId: business.id,
    });

    await this.savedSearchQueue.add(
      'match-saved-searches',
      { businessId: business.id },
      DEFAULT_JOB_OPTIONS,
    );

    return updatedBusiness;
  }

  async unpublish(user: AuthenticatedUser, businessId: string) {
    const business = await this.findOwned(user, businessId);
    this.assertTransition(business.status, BusinessStatus.PAUSED);

    const [updatedBusiness] = await this.prisma.$transaction([
      this.prisma.business.update({
        where: { id: business.id },
        data: { status: BusinessStatus.PAUSED },
      }),
      this.prisma.businessListing.update({
        where: { businessId: business.id },
        data: { status: ListingStatus.UNPUBLISHED },
      }),
    ]);

    await this.auditService.record({
      userId: user.id,
      action: 'BUSINESS_UNPUBLISHED',
      targetType: 'Business',
      targetId: business.id,
    });

    return updatedBusiness;
  }

  private assertTransition(from: BusinessStatus, to: BusinessStatus): void {
    if (!businessStateMachine.canTransition(from, to)) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_INVALID_STATE_TRANSITION,
        `Cannot move a business from ${from} to ${to}`,
      );
    }
  }

  /**
   * Listing content and financials are frozen while under review, once sold
   * or suspended, and for the whole life of an active deal — the buyer is
   * doing due diligence on exactly these numbers.
   */
  private async assertEditable(business: { id: string; status: BusinessStatus }): Promise<void> {
    if (LOCKED_BUSINESS_STATUSES.includes(business.status)) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_LOCKED,
        `This business cannot be edited while it is ${business.status}`,
      );
    }
    if (await this.hasActiveDeal(business.id)) {
      throw new ConflictAppException(
        ErrorCode.BUSINESS_LOCKED,
        'This business cannot be edited while a deal on it is in progress',
      );
    }
  }

  private async hasActiveDeal(businessId: string): Promise<boolean> {
    const count = await this.prisma.deal.count({
      where: { businessId, status: { in: ACTIVE_DEAL_STATUSES } },
    });
    return count > 0;
  }

  private canManage(user: AuthenticatedUser, business: Business): boolean {
    return business.ownerId === user.id || user.role === UserRole.ADMIN;
  }

  private calculateCompleteness(
    business: Business & { listing: { askingPriceMinor: bigint | null } | null },
  ): { score: number; missing: string[] } {
    const missing: string[] = [];
    if (!business.name) missing.push('name');
    if (!business.description) missing.push('description');
    if (!business.categoryId) missing.push('categoryId');
    if (!business.businessModel) missing.push('businessModel');
    if (!business.listing?.askingPriceMinor) missing.push('askingPrice');

    const score = Math.round(
      ((REQUIRED_LISTING_FIELDS.length - missing.length) / REQUIRED_LISTING_FIELDS.length) * 100,
    );
    return { score, missing };
  }
}
