import { Injectable } from '@nestjs/common';
import { Plan } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ErrorCode } from '../common/constants/error-codes';
import { NotFoundAppException, PaymentRequiredAppException } from '../common/errors/app.exception';
import { toMajorUnits } from '../common/utils/money';

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** `priceMinor` is a Prisma `bigint` — JSON.stringify throws on it, so every
   * response path must convert it to a plain number before it reaches the
   * client (same convention as `offers`/`businesses`, see `common/utils/money.ts`). */
  private serializePlan<T extends Plan>(plan: T) {
    const { priceMinor, ...rest } = plan;
    return { ...rest, price: toMajorUnits(priceMinor) };
  }

  async listPlans() {
    const plans = await this.prisma.plan.findMany({ where: { active: true } });
    return plans.map((plan) => this.serializePlan(plan));
  }

  async getOwnSubscription(userId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      return null;
    }
    return { ...subscription, plan: this.serializePlan(subscription.plan) };
  }

  /**
   * Only ever activates a $0 plan directly. There is no payment gateway
   * integration in this codebase yet (no Stripe/checkout call anywhere) —
   * activating a priced plan here would hand out paid entitlements for
   * free. Paid plans must go through a real checkout/payment-confirmation
   * flow (see `webhooks.service.ts` for the signature-verified webhook
   * that already exists for that purpose) before a Subscription row for
   * them is ever created. Until that flow exists, priced plans are
   * rejected here — consistent with the frontend, which already routes
   * paid plans to "Contact sales" instead of self-serve checkout.
   */
  async subscribe(userId: string, planCode: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode as never } });
    if (!plan || !plan.active) {
      throw new NotFoundAppException(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.priceMinor > 0n) {
      throw new PaymentRequiredAppException(
        ErrorCode.BILLING_PAYMENT_REQUIRED,
        'Paid plans require a completed payment. Self-serve checkout is not available yet — contact sales.',
      );
    }

    const subscription = await this.prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      include: { plan: true },
    });
    return { ...subscription, plan: this.serializePlan(subscription.plan) };
  }
}
