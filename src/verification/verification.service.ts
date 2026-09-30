import { Injectable } from '@nestjs/common';
import { UserRole, VerificationStatus } from '@prisma/client';
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
import { SubmitVerificationDto } from './dto/submit-verification.dto';
import { ReviewVerificationDto } from './dto/review-verification.dto';

/** A decision is final; a rejected seller submits a fresh verification. */
const REVIEWABLE_STATUSES: VerificationStatus[] = ['PENDING', 'IN_REVIEW'];

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async submit(user: AuthenticatedUser, businessId: string, dto: SubmitVerificationDto) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business || business.deletedAt) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }
    if (business.ownerId !== user.id && user.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(
        ErrorCode.BUSINESS_ACCESS_DENIED,
        'Only the business owner can submit verification',
      );
    }

    // Evidence may only reference this business's own documents.
    const documentIds = (dto.items ?? [])
      .map((i) => i.documentId)
      .filter((id): id is string => !!id);
    if (documentIds.length) {
      const owned = await this.prisma.businessDocument.count({
        where: { id: { in: documentIds }, businessId, deletedAt: null },
      });
      if (owned !== new Set(documentIds).size) {
        throw new NotFoundAppException(
          ErrorCode.DOCUMENT_NOT_FOUND,
          'Evidence documents must belong to this business',
        );
      }
    }

    const verification = await this.prisma.businessVerification.create({
      data: {
        businessId,
        type: dto.type,
        status: 'PENDING',
        items: {
          create: dto.items?.map((i) => ({
            label: i.label,
            value: i.value,
            documentId: i.documentId,
          })),
        },
        events: { create: { type: 'SUBMITTED' } },
      },
      include: { items: true },
    });

    await this.auditService.record({
      userId: user.id,
      action: 'VERIFICATION_SUBMITTED',
      targetType: 'BusinessVerification',
      targetId: verification.id,
    });

    return verification;
  }

  /**
   * Owner and admin/moderator see full evidence (item label/value/documentId,
   * event notes and reviewer identity). Everyone else gets only the same
   * `{ type, status }` shape already exposed publicly on listing detail
   * (`listings.service.ts`'s `toPublicDetail`) — private verification
   * evidence must never leave this method for a non-owner, non-reviewer.
   */
  async listForBusiness(user: AuthenticatedUser, businessId: string) {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business || business.deletedAt) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }

    const verifications = await this.prisma.businessVerification.findMany({
      where: { businessId },
      include: { items: true, events: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });

    const canSeeEvidence =
      business.ownerId === user.id ||
      user.role === UserRole.ADMIN ||
      user.role === UserRole.MODERATOR;
    if (canSeeEvidence) {
      return verifications;
    }

    return verifications.map((v) => ({ id: v.id, type: v.type, status: v.status }));
  }

  /** Admin/moderator review — never usable by the business owner on their own submission. */
  async review(reviewer: AuthenticatedUser, verificationId: string, dto: ReviewVerificationDto) {
    const verification = await this.prisma.businessVerification.findUnique({
      where: { id: verificationId },
      include: { business: { select: { ownerId: true, name: true } } },
    });
    if (!verification) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Verification not found');
    }
    if (verification.business.ownerId === reviewer.id) {
      throw new ForbiddenAppException(
        ErrorCode.AUTH_FORBIDDEN,
        'You cannot review a verification for your own business',
      );
    }
    if (!REVIEWABLE_STATUSES.includes(verification.status)) {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        `A ${verification.status} verification can no longer be reviewed — the seller must resubmit`,
      );
    }

    const updated = await this.prisma.businessVerification.update({
      where: { id: verificationId },
      data: {
        status: dto.status,
        events: { create: { type: dto.status, note: dto.note, reviewerId: reviewer.id } },
      },
    });

    await this.auditService.record({
      userId: reviewer.id,
      action: 'VERIFICATION_REVIEWED',
      targetType: 'BusinessVerification',
      targetId: verificationId,
      metadata: { status: dto.status },
    });

    await this.notificationsService.create({
      userId: verification.business.ownerId,
      type: 'VERIFICATION_UPDATE',
      title: `${verification.type} verification for ${verification.business.name}: ${dto.status}`,
      body: dto.note,
      metadata: { businessId: verification.businessId, verificationId },
    });

    return updated;
  }
}
