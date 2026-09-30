import { Injectable } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DealsService } from '../deals/deals.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { ErrorCode } from '../common/constants/error-codes';
import { ConflictAppException, NotFoundAppException } from '../common/errors/app.exception';
import { CreateTransactionDto } from './dto/create-transaction.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealsService: DealsService,
  ) {}

  async create(user: AuthenticatedUser, dealId: string, dto: CreateTransactionDto) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      ['BUYER'],
      'Only the buyer starts the payment',
    );

    const deal = await this.prisma.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: { acceptedOffer: true },
    });

    if (deal.status !== 'TRANSACTION') {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        'Deal must be in the TRANSACTION stage to create a payment transaction',
      );
    }

    const transaction = await this.prisma.transaction.upsert({
      where: { dealId },
      create: {
        dealId,
        amountMinor: deal.acceptedOffer.amountMinor,
        currency: deal.acceptedOffer.currency,
        provider: dto.provider ?? 'stripe',
        status: TransactionStatus.PENDING,
        events: { create: { type: 'TRANSACTION_CREATED' } },
      },
      update: {},
    });

    await this.dealsService.addTimelineEvent(dealId, 'TRANSACTION_STARTED', user.id, {
      transactionId: transaction.id,
    });

    return transaction;
  }

  async getForDeal(user: AuthenticatedUser, dealId: string) {
    await this.dealsService.assertParticipant(user.id, dealId);
    const transaction = await this.prisma.transaction.findUnique({
      where: { dealId },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    });
    if (!transaction) {
      throw new NotFoundAppException(
        ErrorCode.NOT_FOUND,
        'No transaction has been started for this deal',
      );
    }
    return transaction;
  }

  /** Idempotent webhook handler: applies a provider status update at most once per providerRef+status. */
  async applyProviderStatusUpdate(
    providerRef: string,
    status: TransactionStatus,
    metadata?: object,
  ): Promise<void> {
    const transaction = await this.prisma.transaction.findFirst({ where: { providerRef } });
    if (!transaction) {
      return;
    }

    await this.prisma.$transaction([
      this.prisma.transaction.update({ where: { id: transaction.id }, data: { status } }),
      this.prisma.transactionEvent.create({
        data: { transactionId: transaction.id, type: `PROVIDER_${status}`, metadata },
      }),
    ]);

    if (status === TransactionStatus.COMPLETED) {
      await this.dealsService.addTimelineEvent(transaction.dealId, 'TRANSACTION_COMPLETED', null, {
        transactionId: transaction.id,
      });
      // Payment confirmed by the provider is the only way into TRANSFER.
      const deal = await this.prisma.deal.findUnique({ where: { id: transaction.dealId } });
      if (deal?.status === 'TRANSACTION') {
        await this.dealsService.transition(deal.id, 'TRANSACTION', 'TRANSFER', null);
      }
    } else {
      await this.dealsService.notifyParticipants(
        transaction.dealId,
        null,
        `Payment status: ${status}`,
      );
    }
  }
}
