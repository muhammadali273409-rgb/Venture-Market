import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ErrorCode } from '../common/constants/error-codes';
import { BUYER_ROLES } from '../common/constants/roles';
import { ForbiddenAppException, NotFoundAppException } from '../common/errors/app.exception';
import { buildCursorPage } from '../common/utils/cursor-pagination';
import { CursorPaginationQuery } from '../common/dto/pagination.dto';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PUBLICLY_REACHABLE } from '../listings/listings.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { StartBusinessConversationDto } from './dto/start-business-conversation.dto';

/** Public participant fields only — never email or other account data. */
const PARTICIPANT_USER_SELECT = {
  id: true,
  role: true,
  profile: { select: { firstName: true, lastName: true, avatarUrl: true, company: true } },
} satisfies Prisma.UserSelect;

const CONVERSATION_INCLUDE = {
  business: { select: { id: true, name: true, slug: true, ownerId: true } },
  participants: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
  messages: {
    where: { deletedAt: null },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
  },
} satisfies Prisma.ConversationInclude;

type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof CONVERSATION_INCLUDE;
}>;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * A buyer contacts the seller of a listing. The seller is always read from
   * the business record — the client never names them — and the buyer gets
   * one thread per business: a second call returns the existing thread
   * (appending the message, if any) instead of creating a duplicate.
   */
  async startForBusiness(
    user: AuthenticatedUser,
    businessId: string,
    dto: StartBusinessConversationDto,
  ) {
    if (!BUYER_ROLES.includes(user.role)) {
      throw new ForbiddenAppException(
        ErrorCode.AUTH_FORBIDDEN,
        'Only buyer accounts can contact sellers about a listing',
      );
    }

    const business = await this.prisma.business.findFirst({
      where: { id: businessId, ...PUBLICLY_REACHABLE },
      select: { id: true, ownerId: true },
    });
    if (!business) {
      throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
    }
    const sellerId = business.ownerId;
    if (sellerId === user.id) {
      throw new ForbiddenAppException(
        ErrorCode.CONVERSATION_ACCESS_DENIED,
        'You cannot start a conversation about your own listing',
      );
    }

    let conversationId = await this.findBuyerThread(business.id, user.id, sellerId);
    let created = false;
    if (!conversationId) {
      try {
        const conversation = await this.prisma.conversation.create({
          data: {
            businessId: business.id,
            buyerId: user.id,
            participants: {
              create: [{ userId: user.id, lastReadAt: new Date() }, { userId: sellerId }],
            },
          },
          select: { id: true },
        });
        conversationId = conversation.id;
        created = true;
      } catch (error) {
        // Two concurrent first clicks: the unique (businessId, buyerId) index
        // lets exactly one create win — use the thread it made.
        if (!isUniqueViolation(error)) throw error;
        conversationId = await this.findBuyerThread(business.id, user.id, sellerId);
        if (!conversationId) throw error;
      }
    }

    if (dto.message) {
      await this.postMessage(user.id, conversationId, dto.message);
    } else if (created) {
      await this.notificationsService.create({
        userId: sellerId,
        type: 'NEW_MESSAGE',
        title: 'A buyer opened a conversation about your listing',
        metadata: { conversationId, businessId: business.id },
      });
    }

    return { ...(await this.getForUser(user, conversationId)), created };
  }

  /**
   * General form (kept for existing clients). An enquiry about a listing
   * whose other participant is its seller goes through startForBusiness;
   * anything else needs an existing offer/negotiation or deal between the two.
   */
  async create(user: AuthenticatedUser, dto: CreateConversationDto) {
    const others = Array.from(new Set(dto.participantIds)).filter((id) => id !== user.id);
    if (others.length !== 1) {
      throw new ForbiddenAppException(
        ErrorCode.CONVERSATION_ACCESS_DENIED,
        'A conversation needs exactly one other participant',
      );
    }
    const [otherId] = others;

    if (dto.businessId) {
      const business = await this.prisma.business.findUnique({
        where: { id: dto.businessId },
        select: { ownerId: true, deletedAt: true },
      });
      if (!business || business.deletedAt) {
        throw new NotFoundAppException(ErrorCode.BUSINESS_NOT_FOUND, 'Business not found');
      }
      if (business.ownerId !== user.id && business.ownerId !== otherId) {
        throw new ForbiddenAppException(
          ErrorCode.CONVERSATION_ACCESS_DENIED,
          'Conversations about a business must include its seller',
        );
      }
      if (business.ownerId === otherId) {
        return this.startForBusiness(user, dto.businessId, { message: dto.initialMessage });
      }
    }

    await this.assertSharedDealOrNegotiation(user.id, otherId, dto.businessId);

    const conversation = await this.prisma.conversation.create({
      data: {
        businessId: dto.businessId,
        participants: {
          create: [{ userId: user.id, lastReadAt: new Date() }, { userId: otherId }],
        },
      },
      select: { id: true },
    });
    await this.postMessage(user.id, conversation.id, dto.initialMessage);
    return { ...(await this.getForUser(user, conversation.id)), created: true };
  }

  async listForUser(user: AuthenticatedUser) {
    const conversations = await this.prisma.conversation.findMany({
      where: { participants: { some: { userId: user.id } } },
      include: CONVERSATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });
    const unread = await this.unreadCounts(user.id);
    return conversations.map((c) => this.serialize(c, unread.get(c.id) ?? 0));
  }

  async getForUser(user: AuthenticatedUser, conversationId: string) {
    await this.assertParticipant(user.id, conversationId);
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: CONVERSATION_INCLUDE,
    });
    const unread = await this.unreadCounts(user.id, conversationId);
    return this.serialize(conversation, unread.get(conversationId) ?? 0);
  }

  /** Newest first; reading a page marks the conversation read for this user. */
  async listMessages(
    user: AuthenticatedUser,
    conversationId: string,
    query: CursorPaginationQuery,
  ) {
    await this.assertParticipant(user.id, conversationId);
    const limit = query.limit ?? 30;

    const messages = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { attachments: true },
    });

    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: user.id },
      data: { lastReadAt: new Date() },
    });

    return buildCursorPage(messages, limit);
  }

  async sendMessage(user: AuthenticatedUser, conversationId: string, dto: SendMessageDto) {
    await this.assertParticipant(user.id, conversationId);
    return this.postMessage(user.id, conversationId, dto.body);
  }

  /** The sender is always the authenticated user — never taken from the request body. */
  private async postMessage(senderId: string, conversationId: string, body: string) {
    const now = new Date();
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { conversationId, senderId, body } }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: now } }),
      // Your own message means you've seen everything before it.
      this.prisma.conversationParticipant.updateMany({
        where: { conversationId, userId: senderId },
        data: { lastReadAt: now },
      }),
    ]);

    const otherParticipants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId, userId: { not: senderId } },
      select: { userId: true },
    });
    for (const participant of otherParticipants) {
      await this.notificationsService.create({
        userId: participant.userId,
        type: 'NEW_MESSAGE',
        title: 'New message',
        metadata: { conversationId, messageId: message.id },
      });
    }

    return message;
  }

  /** The buyer's thread for this business, adopting a pre-existing untagged one if there is one. */
  private async findBuyerThread(
    businessId: string,
    buyerId: string,
    sellerId: string,
  ): Promise<string | null> {
    const tagged = await this.prisma.conversation.findFirst({
      where: { businessId, buyerId },
      select: { id: true },
    });
    if (tagged) return tagged.id;

    // Threads created before buyerId existed.
    const legacy = await this.prisma.conversation.findFirst({
      where: {
        businessId,
        buyerId: null,
        AND: [
          { participants: { some: { userId: buyerId } } },
          { participants: { some: { userId: sellerId } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!legacy) return null;
    try {
      await this.prisma.conversation.update({ where: { id: legacy.id }, data: { buyerId } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return legacy.id;
  }

  /** Unread = messages from others newer than this user's lastReadAt. One query for all threads. */
  private async unreadCounts(
    userId: string,
    conversationId?: string,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT m."conversationId", COUNT(*)::int AS unread
      FROM "messages" m
      JOIN "conversation_participants" p
        ON p."conversationId" = m."conversationId" AND p."userId" = ${userId}
      WHERE m."senderId" <> ${userId}
        AND m."deletedAt" IS NULL
        AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
        ${conversationId ? Prisma.sql`AND m."conversationId" = ${conversationId}` : Prisma.empty}
      GROUP BY m."conversationId"`;
    return new Map(rows.map((r) => [r.conversationId, Number(r.unread)]));
  }

  private serialize(conversation: ConversationWithRelations, unreadCount: number) {
    const { business, ...rest } = conversation;
    return {
      ...rest,
      business: business ? { id: business.id, name: business.name, slug: business.slug } : null,
      /** The seller side of a listing enquiry (the business owner). */
      sellerId: business?.ownerId ?? null,
      lastMessage: conversation.messages[0] ?? null,
      unreadCount,
    };
  }

  private async assertSharedDealOrNegotiation(
    userId: string,
    otherId: string,
    businessId: string | undefined,
  ): Promise<void> {
    const [negotiations, deals] = await Promise.all([
      this.prisma.negotiation.count({
        where: {
          ...(businessId ? { businessId } : {}),
          OR: [
            { buyerId: userId, sellerId: otherId },
            { buyerId: otherId, sellerId: userId },
          ],
        },
      }),
      this.prisma.deal.count({
        where: {
          ...(businessId ? { businessId } : {}),
          AND: [
            { participants: { some: { userId } } },
            { participants: { some: { userId: otherId } } },
          ],
        },
      }),
    ]);
    if (negotiations === 0 && deals === 0) {
      throw new ForbiddenAppException(
        ErrorCode.CONVERSATION_ACCESS_DENIED,
        'You can only message sellers of published businesses or parties you share an offer or deal with',
      );
    }
  }

  private async assertParticipant(userId: string, conversationId: string): Promise<void> {
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!participant) {
      const exists = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!exists) {
        throw new NotFoundAppException(ErrorCode.CONVERSATION_NOT_FOUND, 'Conversation not found');
      }
      throw new ForbiddenAppException(
        ErrorCode.CONVERSATION_ACCESS_DENIED,
        'You are not part of this conversation',
      );
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
