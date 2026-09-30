import { Injectable } from '@nestjs/common';
import { DueDiligenceStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BUYER_SIDE_ROLES, DealsService, SELLER_SIDE_ROLES } from '../deals/deals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ErrorCode } from '../common/constants/error-codes';
import { ForbiddenAppException, NotFoundAppException } from '../common/errors/app.exception';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { CreateDueDiligenceRequestDto } from './dto/create-request.dto';
import { UpdateItemStatusDto } from './dto/update-item-status.dto';

const SELLER_ITEM_STATUSES: DueDiligenceStatus[] = ['UPLOADED'];
const BUYER_ITEM_STATUSES: DueDiligenceStatus[] = [
  'REQUESTED',
  'UNDER_REVIEW',
  'APPROVED',
  'NEEDS_CLARIFICATION',
  'REJECTED',
  'COMPLETED',
];

@Injectable()
export class DueDiligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealsService: DealsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /** Only the buyer side asks for evidence, and only while due diligence is open. */
  async createRequest(user: AuthenticatedUser, dealId: string, dto: CreateDueDiligenceRequestDto) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      BUYER_SIDE_ROLES,
      'Only the buyer side can request due diligence documents',
    );
    await this.dealsService.assertDealStatus(
      dealId,
      'DUE_DILIGENCE',
      'Due diligence requests can only be made during the DUE_DILIGENCE stage',
    );

    const request = await this.prisma.dueDiligenceRequest.create({
      data: {
        dealId,
        category: dto.category,
        title: dto.title,
        requestedById: user.id,
        items: { create: dto.items.map((description) => ({ description })) },
      },
      include: { items: true },
    });

    await this.dealsService.addTimelineEvent(dealId, 'DUE_DILIGENCE_REQUESTED', user.id, {
      requestId: request.id,
    });

    const otherParticipants = await this.prisma.dealParticipant.findMany({
      where: { dealId, userId: { not: user.id } },
    });
    for (const participant of otherParticipants) {
      await this.notificationsService.create({
        userId: participant.userId,
        type: 'DUE_DILIGENCE_REQUEST',
        title: `New due diligence request: ${dto.title}`,
        metadata: { dealId, requestId: request.id },
      });
    }

    return request;
  }

  async listRequests(user: AuthenticatedUser, dealId: string) {
    await this.dealsService.assertParticipant(user.id, dealId);
    return this.prisma.dueDiligenceRequest.findMany({
      where: { dealId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Seller side answers an item (UPLOADED, optionally linking a document of
   * this business). Buyer side decides on it. Neither side can take the
   * other's action.
   */
  async updateItemStatus(
    user: AuthenticatedUser,
    dealId: string,
    itemId: string,
    dto: UpdateItemStatusDto,
  ) {
    const participant = await this.dealsService.assertParticipant(user.id, dealId);
    const deal = await this.dealsService.assertDealStatus(
      dealId,
      'DUE_DILIGENCE',
      'Due diligence items can only be updated during the DUE_DILIGENCE stage',
    );

    const isSellerSide = SELLER_SIDE_ROLES.includes(participant.role);
    const isBuyerSide = BUYER_SIDE_ROLES.includes(participant.role);
    const allowed = isSellerSide ? SELLER_ITEM_STATUSES : isBuyerSide ? BUYER_ITEM_STATUSES : [];
    if (!allowed.includes(dto.status)) {
      throw new ForbiddenAppException(
        ErrorCode.DEAL_ACCESS_DENIED,
        allowed.length
          ? `You can only set: ${allowed.join(', ')}`
          : 'You cannot update due diligence items',
      );
    }
    if (dto.documentId && !isSellerSide) {
      throw new ForbiddenAppException(
        ErrorCode.DEAL_ACCESS_DENIED,
        'Only the seller side attaches documents to due diligence items',
      );
    }

    const item = await this.prisma.dueDiligenceItem.findFirst({
      where: { id: itemId, request: { dealId } },
    });
    if (!item) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Due diligence item not found');
    }

    if (dto.documentId) {
      await this.shareDocumentWithBuyerSide(user.id, deal, dto.documentId);
    }

    const updated = await this.prisma.dueDiligenceItem.update({
      where: { id: itemId },
      data: { status: dto.status, documentId: dto.documentId },
    });

    await this.dealsService.addTimelineEvent(dealId, 'DUE_DILIGENCE_ITEM_UPDATED', user.id, {
      itemId,
      status: dto.status,
    });

    const notifyRoles = isSellerSide ? BUYER_SIDE_ROLES : SELLER_SIDE_ROLES;
    const recipients = await this.prisma.dealParticipant.findMany({
      where: { dealId, role: { in: notifyRoles } },
    });
    for (const recipient of recipients) {
      await this.notificationsService.create({
        userId: recipient.userId,
        type: isSellerSide ? 'DOCUMENT_UPLOADED' : 'DUE_DILIGENCE_REQUEST',
        title: isSellerSide
          ? 'The seller responded to a due diligence item'
          : `A due diligence item was marked ${dto.status}`,
        metadata: { dealId, itemId },
      });
    }

    return updated;
  }

  /**
   * The linked document must be a live document of the deal's business.
   * Linking it is the seller's explicit decision to disclose it, so the
   * buyer side gets an access grant for it.
   */
  private async shareDocumentWithBuyerSide(
    actorId: string,
    deal: { id: string; businessId: string },
    documentId: string,
  ): Promise<void> {
    const document = await this.prisma.businessDocument.findFirst({
      where: { id: documentId, businessId: deal.businessId, deletedAt: null },
    });
    if (!document || (document.dealId && document.dealId !== deal.id)) {
      throw new NotFoundAppException(
        ErrorCode.DOCUMENT_NOT_FOUND,
        'Document not found for this business',
      );
    }

    const buyerSide = await this.prisma.dealParticipant.findMany({
      where: { dealId: deal.id, role: { in: BUYER_SIDE_ROLES } },
    });
    for (const participant of buyerSide) {
      await this.prisma.documentAccess.upsert({
        where: { documentId_granteeId: { documentId, granteeId: participant.userId } },
        create: { documentId, granteeId: participant.userId, grantedById: actorId },
        update: { revokedAt: null },
      });
      await this.prisma.documentAccessLog.create({
        data: { documentId, userId: actorId, action: 'ACCESS_GRANTED' },
      });
    }
  }
}
