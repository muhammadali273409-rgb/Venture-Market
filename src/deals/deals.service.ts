import { Injectable } from '@nestjs/common';
import {
  BusinessStatus,
  DealParticipant,
  DealParticipantRole,
  DealStatus,
  DueDiligenceStatus,
  ListingStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit/audit.service';
import { StateMachine } from '../common/utils/state-machine';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ErrorCode } from '../common/constants/error-codes';
import {
  ConflictAppException,
  ForbiddenAppException,
  NotFoundAppException,
} from '../common/errors/app.exception';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddParticipantDto } from './dto/add-participant.dto';
import { UpdateDealStatusDto } from './dto/update-deal-status.dto';
import { toMajorUnits } from '../common/utils/money';

/**
 * Deal lifecycle. Which *actor* may drive each edge is decided separately in
 * `assertPartyMayTransition` — the state machine only says which edges exist.
 *
 *   INITIATED ─party─▶ NDA ─both sign─▶ DUE_DILIGENCE ─buyer─▶ AGREEMENT
 *     ─both sign agreement─▶ TRANSACTION ─payment provider─▶ TRANSFER
 *     ─seller confirms transfer + buyer confirms receipt─▶ COMPLETED
 */
const dealStateMachine = new StateMachine<DealStatus>({
  INITIATED: ['NDA', 'CANCELLED'],
  NDA: ['DUE_DILIGENCE', 'CANCELLED', 'DISPUTED'],
  DUE_DILIGENCE: ['AGREEMENT', 'CANCELLED', 'DISPUTED'],
  AGREEMENT: ['TRANSACTION', 'CANCELLED', 'DISPUTED'],
  TRANSACTION: ['TRANSFER', 'CANCELLED', 'DISPUTED'],
  TRANSFER: ['COMPLETED', 'DISPUTED'],
  COMPLETED: [],
  CANCELLED: [],
  DISPUTED: ['NDA', 'DUE_DILIGENCE', 'AGREEMENT', 'TRANSACTION', 'TRANSFER', 'CANCELLED'],
});

export const PRINCIPAL_ROLES: DealParticipantRole[] = ['BUYER', 'SELLER'];
export const BUYER_SIDE_ROLES: DealParticipantRole[] = ['BUYER', 'BUYER_ADVISOR'];
export const SELLER_SIDE_ROLES: DealParticipantRole[] = ['SELLER', 'SELLER_ADVISOR'];

/** Advisors a principal may invite onto their own side of the deal. */
const INVITABLE_BY: Partial<Record<DealParticipantRole, DealParticipantRole[]>> = {
  BUYER: ['BUYER_ADVISOR', 'LAWYER', 'ACCOUNTANT'],
  SELLER: ['SELLER_ADVISOR', 'LAWYER', 'ACCOUNTANT'],
};

/** Once money may be moving, only an administrator can cancel. */
const PARTY_CANCELLABLE_STATUSES: DealStatus[] = ['INITIATED', 'NDA', 'DUE_DILIGENCE', 'AGREEMENT'];

export const CLOSED_DEAL_STATUSES: DealStatus[] = ['COMPLETED', 'CANCELLED'];

const OPEN_DUE_DILIGENCE_STATUSES: DueDiligenceStatus[] = [
  'REQUESTED',
  'UPLOADED',
  'UNDER_REVIEW',
  'NEEDS_CLARIFICATION',
];

/** Only public identity fields of other participants ever leave the API. */
const PARTICIPANT_USER_SELECT = {
  id: true,
  role: true,
  profile: { select: { firstName: true, lastName: true, avatarUrl: true, company: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  async assertParticipant(userId: string, dealId: string): Promise<DealParticipant> {
    const participant = await this.prisma.dealParticipant.findUnique({
      where: { dealId_userId: { dealId, userId } },
    });
    if (!participant) {
      const exists = await this.prisma.deal.findUnique({ where: { id: dealId } });
      if (!exists) {
        throw new NotFoundAppException(ErrorCode.DEAL_NOT_FOUND, 'Deal not found');
      }
      throw new ForbiddenAppException(
        ErrorCode.DEAL_ACCESS_DENIED,
        'You are not part of this deal',
      );
    }
    return participant;
  }

  /** Asserts the caller participates in the deal with one of `roles`. */
  async assertParticipantRole(
    userId: string,
    dealId: string,
    roles: DealParticipantRole[],
    message: string,
  ): Promise<DealParticipant> {
    const participant = await this.assertParticipant(userId, dealId);
    if (!roles.includes(participant.role)) {
      throw new ForbiddenAppException(ErrorCode.DEAL_ACCESS_DENIED, message);
    }
    return participant;
  }

  /** Throws unless the deal is currently in `status`. */
  async assertDealStatus(dealId: string, status: DealStatus, message: string) {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) {
      throw new NotFoundAppException(ErrorCode.DEAL_NOT_FOUND, 'Deal not found');
    }
    if (deal.status !== status) {
      throw new ConflictAppException(ErrorCode.DEAL_INVALID_STATE_TRANSITION, message);
    }
    return deal;
  }

  async listForUser(user: AuthenticatedUser) {
    return this.prisma.deal.findMany({
      where: { participants: { some: { userId: user.id } } },
      include: { business: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOne(user: AuthenticatedUser, dealId: string) {
    await this.assertParticipant(user.id, dealId);
    const deal = await this.prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        business: true,
        acceptedOffer: { select: { amountMinor: true, currency: true } },
        participants: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
        tasks: { orderBy: { createdAt: 'desc' } },
        timelineEvents: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!deal) return deal;
    // The price both parties agreed on — shown at the payment stage. BigInt isn't JSON.
    const { amountMinor, currency } = deal.acceptedOffer;
    return { ...deal, acceptedOffer: { amount: toMajorUnits(amountMinor), currency } };
  }

  /**
   * Manual status changes. Stages that are proven by another record (NDA
   * signatures, a signed agreement, a provider-confirmed payment, transfer
   * confirmations) can't be forced from here by a party — they advance
   * automatically through `transition` from the owning service.
   */
  async updateStatus(user: AuthenticatedUser, dealId: string, dto: UpdateDealStatusDto) {
    const isAdmin = user.role === UserRole.ADMIN;
    const participant = isAdmin ? null : await this.assertParticipant(user.id, dealId);

    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) {
      throw new NotFoundAppException(ErrorCode.DEAL_NOT_FOUND, 'Deal not found');
    }
    if (!dealStateMachine.canTransition(deal.status, dto.status)) {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        `Cannot transition deal from ${deal.status} to ${dto.status}`,
      );
    }
    if (participant) {
      await this.assertPartyMayTransition(deal.id, deal.status, dto.status, participant.role);
    }

    return this.transition(deal.id, deal.status, dto.status, user.id);
  }

  /**
   * The single place a deal's status is written. Atomic on `from` so two
   * concurrent callers can't both advance the same stage, and applies the
   * stage's side effects in the same transaction.
   */
  async transition(dealId: string, from: DealStatus, to: DealStatus, actorId: string | null) {
    if (!dealStateMachine.canTransition(from, to)) {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        `Cannot transition deal from ${from} to ${to}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.deal.updateMany({
        where: { id: dealId, status: from },
        data: { status: to },
      });
      if (result.count === 0) {
        throw new ConflictAppException(
          ErrorCode.DEAL_INVALID_STATE_TRANSITION,
          'The deal status changed in the meantime — reload and try again',
        );
      }
      const deal = await tx.deal.findUniqueOrThrow({ where: { id: dealId } });

      if (to === 'NDA') {
        await tx.dealParticipant.updateMany({
          where: { dealId, role: { in: PRINCIPAL_ROLES }, ndaStatus: { not: 'SIGNED' } },
          data: { ndaStatus: 'PENDING' },
        });
      }
      if (to === 'COMPLETED') {
        await tx.business.update({
          where: { id: deal.businessId },
          data: { status: BusinessStatus.SOLD },
        });
        await tx.businessListing.updateMany({
          where: { businessId: deal.businessId },
          data: { status: ListingStatus.SOLD },
        });
      }

      await tx.dealTimelineEvent.create({
        data: { dealId, type: 'DEAL_STATUS_CHANGED', actorId, metadata: { from, to } },
      });
      return deal;
    });

    await this.auditService.record({
      userId: actorId,
      action: 'DEAL_STATUS_CHANGED',
      targetType: 'Deal',
      targetId: dealId,
      metadata: { from, to },
    });
    await this.notifyParticipants(dealId, actorId, `Deal status changed to ${to}`);

    return updated;
  }

  /** Buyer or seller signs the deal NDA; the deal moves on once both have. */
  async signNda(user: AuthenticatedUser, dealId: string) {
    const participant = await this.assertParticipantRole(
      user.id,
      dealId,
      PRINCIPAL_ROLES,
      'Only the buyer and seller sign the deal NDA',
    );
    await this.assertDealStatus(dealId, 'NDA', 'The deal is not waiting for NDA signatures');
    if (participant.ndaStatus === 'SIGNED') {
      throw new ConflictAppException(ErrorCode.CONFLICT, 'You have already signed the NDA');
    }

    await this.prisma.dealParticipant.update({
      where: { id: participant.id },
      data: { ndaStatus: 'SIGNED', ndaSignedAt: new Date() },
    });
    await this.addTimelineEvent(dealId, 'NDA_SIGNED', user.id, { role: participant.role });
    await this.auditService.record({
      userId: user.id,
      action: 'DEAL_NDA_SIGNED',
      targetType: 'Deal',
      targetId: dealId,
    });

    const unsigned = await this.prisma.dealParticipant.count({
      where: { dealId, role: { in: PRINCIPAL_ROLES }, ndaStatus: { not: 'SIGNED' } },
    });
    if (unsigned === 0) {
      return this.transition(dealId, 'NDA', 'DUE_DILIGENCE', null);
    }
    await this.notifyParticipants(dealId, user.id, 'The other party signed the NDA');
    return this.prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  }

  /** Seller states the business has been handed over (credentials, domains, assets…). */
  async confirmTransfer(user: AuthenticatedUser, dealId: string) {
    await this.assertParticipantRole(
      user.id,
      dealId,
      ['SELLER'],
      'Only the seller confirms the business transfer',
    );
    await this.assertDealStatus(dealId, 'TRANSFER', 'The deal is not in the transfer stage');

    const result = await this.prisma.deal.updateMany({
      where: { id: dealId, status: 'TRANSFER', sellerTransferConfirmedAt: null },
      data: { sellerTransferConfirmedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictAppException(ErrorCode.CONFLICT, 'Transfer was already confirmed');
    }

    await this.addTimelineEvent(dealId, 'TRANSFER_CONFIRMED_BY_SELLER', user.id);
    await this.auditService.record({
      userId: user.id,
      action: 'DEAL_TRANSFER_CONFIRMED',
      targetType: 'Deal',
      targetId: dealId,
    });
    await this.notifyParticipants(
      dealId,
      user.id,
      'The seller confirmed the business transfer — please confirm receipt',
    );
    return this.prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
  }

  /** Buyer confirms they received the business; this is what completes the deal. */
  async confirmReceipt(user: AuthenticatedUser, dealId: string) {
    await this.assertParticipantRole(
      user.id,
      dealId,
      ['BUYER'],
      'Only the buyer confirms receipt of the business',
    );
    const deal = await this.assertDealStatus(
      dealId,
      'TRANSFER',
      'The deal is not in the transfer stage',
    );
    if (!deal.sellerTransferConfirmedAt) {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        'The seller has not confirmed the transfer yet',
      );
    }

    await this.prisma.deal.update({
      where: { id: dealId },
      data: { buyerReceiptConfirmedAt: new Date() },
    });
    await this.addTimelineEvent(dealId, 'RECEIPT_CONFIRMED_BY_BUYER', user.id);
    return this.transition(dealId, 'TRANSFER', 'COMPLETED', user.id);
  }

  async addParticipant(user: AuthenticatedUser, dealId: string, dto: AddParticipantDto) {
    const isAdmin = user.role === UserRole.ADMIN;
    if (PRINCIPAL_ROLES.includes(dto.role)) {
      // Buyer and seller are fixed by the accepted offer.
      throw new ForbiddenAppException(
        ErrorCode.DEAL_ACCESS_DENIED,
        'The buyer and seller of a deal cannot be changed',
      );
    }
    if (!isAdmin) {
      const participant = await this.assertParticipant(user.id, dealId);
      const allowed = INVITABLE_BY[participant.role] ?? [];
      if (!allowed.includes(dto.role)) {
        throw new ForbiddenAppException(
          ErrorCode.DEAL_ACCESS_DENIED,
          allowed.length
            ? `You can only invite: ${allowed.join(', ')}`
            : 'Only the buyer or seller can invite participants',
        );
      }
    }

    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) {
      throw new NotFoundAppException(ErrorCode.DEAL_NOT_FOUND, 'Deal not found');
    }
    if (CLOSED_DEAL_STATUSES.includes(deal.status)) {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        'Participants cannot be added to a closed deal',
      );
    }
    const invitee = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!invitee || invitee.deletedAt) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'User not found');
    }
    const existing = await this.prisma.dealParticipant.findUnique({
      where: { dealId_userId: { dealId, userId: dto.userId } },
    });
    if (existing) {
      // Never silently re-role someone — that is how a party could demote the other side.
      throw new ConflictAppException(ErrorCode.CONFLICT, 'This user is already part of the deal');
    }

    const created = await this.prisma.dealParticipant.create({
      data: { dealId, userId: dto.userId, role: dto.role },
    });

    await this.addTimelineEvent(dealId, 'PARTICIPANT_ADDED', user.id, {
      userId: dto.userId,
      role: dto.role,
    });
    await this.auditService.record({
      userId: user.id,
      action: 'DEAL_PARTICIPANT_ADDED',
      targetType: 'Deal',
      targetId: dealId,
      metadata: { userId: dto.userId, role: dto.role },
    });
    return created;
  }

  async createTask(user: AuthenticatedUser, dealId: string, dto: CreateTaskDto) {
    await this.assertParticipant(user.id, dealId);
    if (dto.ownerId) {
      const owner = await this.prisma.dealParticipant.findUnique({
        where: { dealId_userId: { dealId, userId: dto.ownerId } },
      });
      if (!owner) {
        throw new ForbiddenAppException(
          ErrorCode.DEAL_ACCESS_DENIED,
          'Tasks can only be assigned to deal participants',
        );
      }
    }
    const task = await this.prisma.dealTask.create({
      data: {
        dealId,
        title: dto.title,
        description: dto.description,
        ownerId: dto.ownerId,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
      },
    });
    await this.addTimelineEvent(dealId, 'TASK_CREATED', user.id, { taskId: task.id });
    return task;
  }

  async listTasks(user: AuthenticatedUser, dealId: string) {
    await this.assertParticipant(user.id, dealId);
    return this.prisma.dealTask.findMany({ where: { dealId }, orderBy: { createdAt: 'asc' } });
  }

  async updateTaskStatus(
    user: AuthenticatedUser,
    dealId: string,
    taskId: string,
    dto: UpdateTaskStatusDto,
  ) {
    await this.assertParticipant(user.id, dealId);
    const task = await this.prisma.dealTask.findFirst({ where: { id: taskId, dealId } });
    if (!task) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Task not found');
    }
    const updated = await this.prisma.dealTask.update({
      where: { id: taskId },
      data: { status: dto.status },
    });
    if (dto.status === 'COMPLETED') {
      await this.addTimelineEvent(dealId, 'TASK_COMPLETED', user.id, { taskId });
    }
    return updated;
  }

  async addTimelineEvent(
    dealId: string,
    type: string,
    actorId: string | null,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.dealTimelineEvent.create({ data: { dealId, type, actorId, metadata } });
  }

  async notifyParticipants(dealId: string, actorId: string | null, title: string) {
    const others = await this.prisma.dealParticipant.findMany({
      where: { dealId, ...(actorId ? { userId: { not: actorId } } : {}) },
    });
    for (const p of others) {
      await this.notificationsService.create({
        userId: p.userId,
        type: 'DEAL_UPDATE',
        title,
        metadata: { dealId },
      });
    }
  }

  /**
   * What a buyer/seller may do through PATCH /deals/:id/status. Admins skip
   * this entirely (any edge the state machine allows).
   */
  private async assertPartyMayTransition(
    dealId: string,
    from: DealStatus,
    to: DealStatus,
    role: DealParticipantRole,
  ): Promise<void> {
    const forbid = (message: string): never => {
      throw new ForbiddenAppException(ErrorCode.DEAL_ACCESS_DENIED, message);
    };
    const conflict = (message: string): never => {
      throw new ConflictAppException(ErrorCode.DEAL_INVALID_STATE_TRANSITION, message);
    };

    if (!PRINCIPAL_ROLES.includes(role)) {
      forbid('Only the buyer or seller can change the deal status');
    }
    if (from === 'DISPUTED') {
      forbid('Only an administrator can resolve a disputed deal');
    }

    switch (to) {
      case 'NDA':
      case 'DISPUTED':
        return;
      case 'DUE_DILIGENCE':
        return conflict('Due diligence starts automatically once both parties sign the NDA');
      case 'AGREEMENT': {
        if (role !== 'BUYER') {
          forbid('Only the buyer can close due diligence');
        }
        // Closing an empty checklist would skip due diligence entirely.
        const totalItems = await this.prisma.dueDiligenceItem.count({
          where: { request: { dealId } },
        });
        if (totalItems === 0) {
          throw new ConflictAppException(
            ErrorCode.DUE_DILIGENCE_NO_ITEMS,
            'Add at least one due diligence item before closing due diligence',
          );
        }
        const openItems = await this.prisma.dueDiligenceItem.count({
          where: { request: { dealId }, status: { in: OPEN_DUE_DILIGENCE_STATUSES } },
        });
        if (openItems > 0) {
          throw new ConflictAppException(
            ErrorCode.DUE_DILIGENCE_ITEMS_OPEN,
            `${openItems} due diligence item(s) are still open`,
            { openItems },
          );
        }
        return;
      }
      case 'TRANSACTION':
        return conflict('Payment starts automatically once both parties sign the agreement');
      case 'TRANSFER':
        return conflict('Transfer starts automatically once the payment provider confirms payment');
      case 'COMPLETED':
        return conflict('Use confirm-transfer (seller) and confirm-receipt (buyer) to complete');
      case 'CANCELLED':
        if (!PARTY_CANCELLABLE_STATUSES.includes(from)) {
          forbid('Once payment has started only an administrator can cancel the deal');
        }
        return;
      default:
        forbid('This status change is not allowed');
    }
  }
}
