import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transaction, TransactionStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DealsService } from '../deals/deals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { AppConfiguration } from '../config/configuration';
import { ErrorCode } from '../common/constants/error-codes';
import {
  AppException,
  ConflictAppException,
  ForbiddenAppException,
  NotFoundAppException,
} from '../common/errors/app.exception';
import { toMajorUnits } from '../common/utils/money';
import { MarkPaidDto } from './dto/mark-paid.dto';

export type PaymentProvider = 'manual' | 'stripe';

/** A failed or abandoned attempt can be retried; anything else is in flight or done. */
const RESTARTABLE_STATUSES: TransactionStatus[] = ['FAILED', 'CANCELLED'];

/** BigInt can't be JSON-serialized, so money leaves the API as string minor + number major. */
export function serializeTransaction<T extends Transaction>(transaction: T) {
  return {
    ...transaction,
    amountMinor: transaction.amountMinor.toString(),
    amount: toMajorUnits(transaction.amountMinor),
  };
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dealsService: DealsService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  /** Which payment flow this deployment uses — the UI picks its buttons from this. */
  getPaymentConfig(): { provider: PaymentProvider; manualInstructions: string } {
    const payments = this.configService.get('payments', { infer: true });
    return { provider: payments.provider, manualInstructions: payments.manualInstructions };
  }

  /**
   * Buyer starts paying. The provider is the server's choice (PAYMENT_PROVIDER),
   * never the client's. For Stripe this returns a Checkout URL to redirect to.
   */
  async create(user: AuthenticatedUser, dealId: string) {
    await this.dealsService.assertParticipantRole(
      user.id,
      dealId,
      ['BUYER'],
      'Only the buyer starts the payment',
    );
    const provider = this.getPaymentConfig().provider;
    const stripeKey = this.configService.get('stripe', { infer: true }).secretKey;
    if (provider === 'stripe' && !stripeKey) {
      // Fail loudly instead of creating a transaction nothing can ever complete.
      throw new AppException(
        ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
        'Card payments are not configured on this server — the administrator must add Stripe keys or set PAYMENT_PROVIDER=manual',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const deal = await this.prisma.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: { acceptedOffer: true, business: { select: { name: true } } },
    });
    if (deal.status !== 'TRANSACTION') {
      throw new ConflictAppException(
        ErrorCode.DEAL_INVALID_STATE_TRANSITION,
        'Deal must be in the TRANSACTION stage to create a payment transaction',
      );
    }

    let transaction = await this.prisma.transaction.findUnique({ where: { dealId } });
    if (!transaction) {
      transaction = await this.prisma.transaction.create({
        data: {
          dealId,
          amountMinor: deal.acceptedOffer.amountMinor,
          currency: deal.acceptedOffer.currency,
          provider,
          status: TransactionStatus.PENDING,
          events: { create: { type: 'TRANSACTION_CREATED', metadata: { provider } } },
        },
      });
      await this.dealsService.addTimelineEvent(dealId, 'TRANSACTION_STARTED', user.id, {
        transactionId: transaction.id,
        provider,
      });
    } else if (
      RESTARTABLE_STATUSES.includes(transaction.status) ||
      (transaction.status === 'PENDING' && transaction.provider !== provider)
    ) {
      transaction = await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          provider,
          status: TransactionStatus.PENDING,
          events: { create: { type: 'TRANSACTION_RESTARTED', metadata: { provider } } },
        },
      });
    }

    if (provider === 'stripe' && transaction.status === 'PENDING') {
      const session = await this.createStripeCheckoutSession(
        stripeKey,
        transaction,
        deal.business.name,
      );
      transaction = await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          providerRef: session.id,
          events: {
            create: { type: 'STRIPE_CHECKOUT_CREATED', metadata: { sessionId: session.id } },
          },
        },
      });
      return { ...serializeTransaction(transaction), checkoutUrl: session.url };
    }

    return serializeTransaction(transaction);
  }

  /** `null` (not 404) when payment hasn't started — that's a normal state, not an error. */
  async getForDeal(user: AuthenticatedUser, dealId: string) {
    await this.dealsService.assertParticipant(user.id, dealId);
    const transaction = await this.prisma.transaction.findUnique({
      where: { dealId },
      include: { events: { orderBy: { createdAt: 'desc' } } },
    });
    return transaction ? serializeTransaction(transaction) : null;
  }

  /**
   * Manual flow, buyer side: "I have paid". Creates the transaction if the
   * buyer hasn't started it yet. Only an admin's confirmation moves money
   * forward — this just puts the payment in the admin's queue.
   */
  async markPaid(user: AuthenticatedUser, dealId: string, dto: MarkPaidDto) {
    const started = await this.create(user, dealId);
    if (started.provider !== 'manual') {
      throw new ConflictAppException(
        ErrorCode.PAYMENT_NOT_MANUAL,
        'This deal is paid by card — use the payment page instead',
      );
    }
    if (started.status !== 'PENDING') {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        started.status === 'PROCESSING'
          ? 'You have already marked this payment as sent — an administrator is checking it'
          : `The payment is already ${started.status.toLowerCase()}`,
      );
    }

    const reference = dto.reference?.trim() || undefined;
    const updated = await this.prisma.transaction.update({
      where: { id: started.id },
      data: {
        status: TransactionStatus.PROCESSING,
        events: { create: { type: 'BUYER_MARKED_PAID', metadata: { userId: user.id, reference } } },
      },
    });
    await this.dealsService.addTimelineEvent(dealId, 'PAYMENT_MARKED_SENT', user.id, {
      transactionId: updated.id,
    });
    await this.dealsService.notifyParticipants(
      dealId,
      user.id,
      'The buyer marked the payment as sent — waiting for administrator confirmation',
    );
    await this.notifyAdmins(dealId, 'A deal payment is waiting for your confirmation');
    return serializeTransaction(updated);
  }

  /** Admin queue: manual payments, most recently changed first, optionally by status. */
  async listForAdmin(status?: TransactionStatus) {
    const transactions = await this.prisma.transaction.findMany({
      where: { provider: 'manual', ...(status ? { status } : {}) },
      include: {
        events: { orderBy: { createdAt: 'desc' } },
        deal: {
          select: {
            id: true,
            status: true,
            business: { select: { id: true, name: true } },
            participants: {
              where: { role: { in: ['BUYER', 'SELLER'] } },
              select: { role: true, user: { select: { id: true, email: true } } },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return transactions.map(serializeTransaction);
  }

  /**
   * Admin confirms the funds arrived. This is the manual-flow counterpart of
   * the Stripe webhook and the only way a manual payment reaches TRANSFER.
   */
  async confirmManualPayment(admin: AuthenticatedUser, transactionId: string) {
    const transaction = await this.getManualTransaction(admin, transactionId);
    if (transaction.status !== 'PROCESSING') {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        transaction.status === 'COMPLETED'
          ? 'This payment was already confirmed'
          : 'The buyer has not marked this payment as sent yet',
      );
    }
    await this.dealsService.assertDealStatus(
      transaction.dealId,
      'TRANSACTION',
      'The deal is not waiting for payment',
    );

    const result = await this.prisma.transaction.updateMany({
      where: { id: transactionId, status: 'PROCESSING' },
      data: { status: TransactionStatus.COMPLETED },
    });
    if (result.count === 0) {
      throw new ConflictAppException(ErrorCode.CONFLICT, 'The payment changed in the meantime');
    }
    await this.prisma.transactionEvent.create({
      data: { transactionId, type: 'ADMIN_CONFIRMED_PAYMENT', metadata: { adminId: admin.id } },
    });
    await this.dealsService.addTimelineEvent(
      transaction.dealId,
      'TRANSACTION_COMPLETED',
      admin.id,
      { transactionId },
    );
    await this.auditService.record({
      userId: admin.id,
      action: 'DEAL_PAYMENT_CONFIRMED',
      targetType: 'Transaction',
      targetId: transactionId,
      metadata: { dealId: transaction.dealId },
    });
    await this.dealsService.transition(transaction.dealId, 'TRANSACTION', 'TRANSFER', admin.id);

    return serializeTransaction(
      await this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
    );
  }

  /** Admin: the money did not arrive — send it back to the buyer to pay again. */
  async rejectManualPayment(admin: AuthenticatedUser, transactionId: string, reason?: string) {
    const transaction = await this.getManualTransaction(admin, transactionId);
    if (transaction.status !== 'PROCESSING') {
      throw new ConflictAppException(
        ErrorCode.CONFLICT,
        'Only a payment marked as sent can be rejected',
      );
    }
    const updated = await this.prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: TransactionStatus.PENDING,
        events: {
          create: { type: 'ADMIN_REJECTED_PAYMENT', metadata: { adminId: admin.id, reason } },
        },
      },
    });
    await this.auditService.record({
      userId: admin.id,
      action: 'DEAL_PAYMENT_REJECTED',
      targetType: 'Transaction',
      targetId: transactionId,
      metadata: { dealId: transaction.dealId, reason },
    });
    await this.dealsService.notifyParticipants(
      transaction.dealId,
      admin.id,
      'The administrator could not confirm the payment — please check it and mark it as sent again',
    );
    return serializeTransaction(updated);
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

  private async getManualTransaction(admin: AuthenticatedUser, transactionId: string) {
    // The controller's RolesGuard already enforces this; keep the service safe on its own.
    if (admin.role !== UserRole.ADMIN) {
      throw new ForbiddenAppException(ErrorCode.AUTH_FORBIDDEN, 'Insufficient permissions');
    }
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) {
      throw new NotFoundAppException(ErrorCode.TRANSACTION_NOT_FOUND, 'Payment not found');
    }
    if (transaction.provider !== 'manual') {
      throw new ConflictAppException(
        ErrorCode.PAYMENT_NOT_MANUAL,
        'Card payments are confirmed by the payment provider, not by an administrator',
      );
    }
    return transaction;
  }

  private async notifyAdmins(dealId: string, title: string): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: { role: UserRole.ADMIN, deletedAt: null },
      select: { id: true },
      take: 50,
    });
    for (const admin of admins) {
      await this.notificationsService.create({
        userId: admin.id,
        type: 'DEAL_UPDATE',
        title,
        metadata: { dealId },
      });
    }
  }

  /**
   * Stripe Checkout through its REST API (no SDK dependency). The session id
   * is stored as providerRef, so `checkout.session.completed` finds it.
   */
  private async createStripeCheckoutSession(
    secretKey: string,
    transaction: Transaction,
    businessName: string,
  ): Promise<{ id: string; url: string }> {
    const frontendUrl = this.configService.get('frontendUrl', { infer: true });
    const dealUrl = `${frontendUrl}/dashboard/deals/${transaction.dealId}`;
    const body = new URLSearchParams({
      mode: 'payment',
      success_url: `${dealUrl}?payment=success`,
      cancel_url: `${dealUrl}?payment=cancelled`,
      client_reference_id: transaction.id,
      'metadata[dealId]': transaction.dealId,
      'metadata[transactionId]': transaction.id,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': transaction.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': transaction.amountMinor.toString(),
      'line_items[0][price_data][product_data][name]': businessName,
    });

    let response: Response;
    try {
      response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch {
      throw new AppException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Could not reach the payment provider — try again in a minute',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    };
    if (!response.ok || !payload.id || !payload.url) {
      throw new AppException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        `The payment provider refused the payment: ${payload.error?.message ?? response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { id: payload.id, url: payload.url };
  }
}
