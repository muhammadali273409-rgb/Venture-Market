import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { AppConfiguration } from '../config/configuration';
import { ErrorCode } from '../common/constants/error-codes';
import { AppException } from '../common/errors/app.exception';
import { HttpStatus } from '@nestjs/common';
import { verifyStripeSignature } from './stripe-signature.util';

interface StripeEventLike {
  id: string;
  type: string;
  data: { object: { id: string; metadata?: Record<string, string>; payment_status?: string } };
}

const STATUS_BY_EVENT_TYPE: Record<string, TransactionStatus> = {
  // Deal payments use Checkout: providerRef is the Checkout Session id.
  'checkout.session.completed': TransactionStatus.COMPLETED,
  'checkout.session.async_payment_succeeded': TransactionStatus.COMPLETED,
  'checkout.session.async_payment_failed': TransactionStatus.FAILED,
  'checkout.session.expired': TransactionStatus.CANCELLED,
  'payment_intent.succeeded': TransactionStatus.COMPLETED,
  'payment_intent.payment_failed': TransactionStatus.FAILED,
  'payment_intent.canceled': TransactionStatus.CANCELLED,
  'charge.refunded': TransactionStatus.REFUNDED,
};

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService<AppConfiguration, true>,
  ) {}

  async handleStripeEvent(
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): Promise<{ received: true }> {
    const secret = this.configService.get('stripe', { infer: true }).webhookSecret;
    if (!secret || !signatureHeader || !verifyStripeSignature(rawBody, signatureHeader, secret)) {
      throw new AppException(
        ErrorCode.WEBHOOK_INVALID_SIGNATURE,
        'Invalid webhook signature',
        HttpStatus.BAD_REQUEST,
      );
    }

    const event = JSON.parse(rawBody.toString('utf8')) as StripeEventLike;

    // Idempotency: a (provider, eventId) unique constraint guarantees at-most-once processing.
    try {
      await this.prisma.webhookEvent.create({ data: { provider: 'stripe', eventId: event.id } });
    } catch {
      return { received: true }; // already processed
    }

    const status = STATUS_BY_EVENT_TYPE[event.type];
    // A completed Checkout with a delayed method (bank debit) is not paid yet —
    // checkout.session.async_payment_succeeded follows when it is.
    const unpaidCheckout =
      event.type === 'checkout.session.completed' &&
      event.data.object.payment_status !== undefined &&
      event.data.object.payment_status !== 'paid';
    if (status && !unpaidCheckout) {
      await this.transactionsService.applyProviderStatusUpdate(event.data.object.id, status, {
        eventType: event.type,
      });
    }

    return { received: true };
  }
}
