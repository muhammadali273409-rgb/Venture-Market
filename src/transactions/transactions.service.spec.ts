import { TransactionsService } from './transactions.service';
import { DealsService } from '../deals/deals.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const buyer: AuthenticatedUser = { id: 'buyer-1', email: 'b@example.com', role: 'BUYER' };
const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const admin: AuthenticatedUser = { id: 'admin-1', email: 'x@example.com', role: 'ADMIN' };

const ROLES: Record<string, string> = { [buyer.id]: 'BUYER', [seller.id]: 'SELLER' };

function errorCode(code: string) {
  return { response: { error: expect.objectContaining({ code }) } };
}

function makeTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    dealId: 'deal-1',
    amountMinor: 5_000_000n,
    currency: 'USD',
    status: 'PENDING',
    provider: 'manual',
    providerRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(
  opts: {
    provider?: 'manual' | 'stripe';
    stripeKey?: string;
    dealStatus?: string;
    transaction?: Record<string, unknown> | null;
  } = {},
) {
  const { provider = 'manual', stripeKey = '', dealStatus = 'TRANSACTION' } = opts;
  let current = opts.transaction === undefined ? null : opts.transaction;
  const deal = {
    id: 'deal-1',
    businessId: 'biz-1',
    status: dealStatus,
    acceptedOffer: { amountMinor: 5_000_000n, currency: 'USD' },
    business: { name: 'Muhammadshop' },
  };
  const tx = {
    deal: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(async () => deal),
    },
    dealParticipant: { updateMany: jest.fn() },
    business: { update: jest.fn() },
    businessListing: { updateMany: jest.fn() },
    dealTimelineEvent: { create: jest.fn() },
  };
  const prisma = {
    dealParticipant: {
      findUnique: jest.fn(async ({ where }: { where: { dealId_userId: { userId: string } } }) => {
        const role = ROLES[where.dealId_userId.userId];
        return role ? { id: `p-${role}`, role } : null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    deal: {
      findUnique: jest.fn(async () => deal),
      findUniqueOrThrow: jest.fn(async () => deal),
    },
    transaction: {
      findUnique: jest.fn(async () => current),
      findUniqueOrThrow: jest.fn(async () => current),
      create: jest.fn(async ({ data }) => {
        const { events, ...rest } = data;
        void events;
        current = makeTransaction(rest);
        return current;
      }),
      update: jest.fn(async ({ data }) => {
        const { events, ...rest } = data;
        void events;
        current = { ...current, ...rest };
        return current;
      }),
      updateMany: jest.fn(async ({ data }) => {
        current = { ...current, ...data };
        return { count: 1 };
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    transactionEvent: { create: jest.fn() },
    user: { findMany: jest.fn().mockResolvedValue([{ id: admin.id }]) },
    dealTimelineEvent: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'payments') return { provider, manualInstructions: 'Pay to IBAN TJ00' };
      if (key === 'stripe') return { secretKey: stripeKey, webhookSecret: '' };
      if (key === 'frontendUrl') return 'https://venture-market.vercel.app';
      return undefined;
    }),
  };
  const notifications = { create: jest.fn() };
  const audit = { record: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deals = new DealsService(prisma as any, notifications as any, audit as any);
  const service = new TransactionsService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any,
    deals,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notifications as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audit as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config as any,
  );
  return { service, prisma, tx, notifications, audit };
}

afterEach(() => jest.restoreAllMocks());

describe('TransactionsService.create', () => {
  it('only the buyer starts the payment', async () => {
    const { service } = setup();
    await expect(service.create(seller, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('refuses outside the TRANSACTION stage', async () => {
    const { service } = setup({ dealStatus: 'AGREEMENT' });
    await expect(service.create(buyer, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });

  it('manual: creates a PENDING manual transaction with JSON-safe money', async () => {
    const { service } = setup();
    const result = await service.create(buyer, 'deal-1');
    expect(result).toMatchObject({
      provider: 'manual',
      status: 'PENDING',
      amountMinor: '5000000',
      amount: 50000,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('stripe without keys fails with a clear error instead of a stuck deal', async () => {
    const { service, prisma } = setup({ provider: 'stripe', stripeKey: '' });
    await expect(service.create(buyer, 'deal-1')).rejects.toMatchObject(
      errorCode('PAYMENT_PROVIDER_NOT_CONFIGURED'),
    );
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('stripe with keys returns a Checkout URL and stores the session as providerRef', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' }),
    } as Response);
    const { service } = setup({ provider: 'stripe', stripeKey: 'sk_test_x' });
    const result = await service.create(buyer, 'deal-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/checkout/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toMatchObject({
      providerRef: 'cs_test_1',
      checkoutUrl: 'https://checkout.stripe.com/c/cs_test_1',
    });
  });

  it('stripe errors surface the provider message', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid currency' } }),
    } as Response);
    const { service } = setup({ provider: 'stripe', stripeKey: 'sk_test_x' });
    await expect(service.create(buyer, 'deal-1')).rejects.toMatchObject({
      response: {
        error: expect.objectContaining({
          code: 'PAYMENT_PROVIDER_ERROR',
          message: expect.stringContaining('Invalid currency'),
        }),
      },
    });
  });
});

describe('TransactionsService.getForDeal', () => {
  it('returns null rather than 404 when payment has not started', async () => {
    const { service } = setup();
    await expect(service.getForDeal(buyer, 'deal-1')).resolves.toBeNull();
  });
});

describe('TransactionsService.markPaid (manual)', () => {
  it('buyer marks the payment as sent; admins are notified', async () => {
    const { service, notifications } = setup();
    const result = await service.markPaid(buyer, 'deal-1', { reference: ' TRX-42 ' });
    expect(result.status).toBe('PROCESSING');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: admin.id }),
    );
  });

  it('the seller cannot mark it', async () => {
    const { service } = setup();
    await expect(service.markPaid(seller, 'deal-1', {})).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('cannot be marked twice', async () => {
    const { service } = setup({ transaction: makeTransaction({ status: 'PROCESSING' }) });
    await expect(service.markPaid(buyer, 'deal-1', {})).rejects.toMatchObject(
      errorCode('CONFLICT'),
    );
  });

  it('marking paid does not move the deal', async () => {
    const { service, tx } = setup();
    await service.markPaid(buyer, 'deal-1', {});
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });
});

describe('TransactionsService admin confirmation', () => {
  it('only an admin confirms', async () => {
    const { service } = setup({ transaction: makeTransaction({ status: 'PROCESSING' }) });
    await expect(service.confirmManualPayment(buyer, 'tx-1')).rejects.toMatchObject(
      errorCode('AUTH_FORBIDDEN'),
    );
    await expect(service.confirmManualPayment(seller, 'tx-1')).rejects.toMatchObject(
      errorCode('AUTH_FORBIDDEN'),
    );
  });

  it('admin confirmation completes the payment and moves the deal to TRANSFER', async () => {
    const { service, tx, audit } = setup({
      transaction: makeTransaction({ status: 'PROCESSING' }),
    });
    const result = await service.confirmManualPayment(admin, 'tx-1');
    expect(result.status).toBe('COMPLETED');
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: 'deal-1', status: 'TRANSACTION' },
      data: { status: 'TRANSFER' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEAL_PAYMENT_CONFIRMED', userId: admin.id }),
    );
  });

  it('cannot confirm before the buyer marks it as sent', async () => {
    const { service, tx } = setup({ transaction: makeTransaction({ status: 'PENDING' }) });
    await expect(service.confirmManualPayment(admin, 'tx-1')).rejects.toMatchObject(
      errorCode('CONFLICT'),
    );
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });

  it('cannot confirm a Stripe payment by hand', async () => {
    const { service } = setup({
      transaction: makeTransaction({ status: 'PROCESSING', provider: 'stripe' }),
    });
    await expect(service.confirmManualPayment(admin, 'tx-1')).rejects.toMatchObject(
      errorCode('PAYMENT_NOT_MANUAL'),
    );
  });

  it('refuses when the deal is no longer in TRANSACTION', async () => {
    const { service } = setup({
      dealStatus: 'CANCELLED',
      transaction: makeTransaction({ status: 'PROCESSING' }),
    });
    await expect(service.confirmManualPayment(admin, 'tx-1')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });

  it('a rejected payment goes back to PENDING so the buyer can retry', async () => {
    const { service } = setup({ transaction: makeTransaction({ status: 'PROCESSING' }) });
    const result = await service.rejectManualPayment(admin, 'tx-1', 'Nothing arrived');
    expect(result.status).toBe('PENDING');
  });

  it('unknown payment is TRANSACTION_NOT_FOUND', async () => {
    const { service } = setup({ transaction: null });
    await expect(service.confirmManualPayment(admin, 'tx-x')).rejects.toMatchObject(
      errorCode('TRANSACTION_NOT_FOUND'),
    );
  });
});
