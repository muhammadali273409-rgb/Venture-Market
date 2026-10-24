import { DealsService } from './deals.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const buyer: AuthenticatedUser = { id: 'buyer-1', email: 'b@example.com', role: 'BUYER' };
const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const advisor: AuthenticatedUser = { id: 'adv-1', email: 'a@example.com', role: 'BUYER' };
const admin: AuthenticatedUser = { id: 'admin-1', email: 'x@example.com', role: 'ADMIN' };

const PARTICIPANTS: Record<string, { id: string; role: string; ndaStatus: string }> = {
  [buyer.id]: { id: 'p-buyer', role: 'BUYER', ndaStatus: 'PENDING' },
  [seller.id]: { id: 'p-seller', role: 'SELLER', ndaStatus: 'PENDING' },
  [advisor.id]: { id: 'p-adv', role: 'BUYER_ADVISOR', ndaStatus: 'NOT_REQUIRED' },
};

/** AppException keeps the machine code under response.error.code. */
function errorCode(code: string) {
  return { response: { error: expect.objectContaining({ code }) } };
}

function setup(dealOverrides: Record<string, unknown> = {}, ddCounts = { total: 0, open: 0 }) {
  const deal = {
    id: 'deal-1',
    businessId: 'biz-1',
    status: 'DUE_DILIGENCE',
    sellerTransferConfirmedAt: null,
    ...dealOverrides,
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
      findUnique: jest.fn(
        async ({ where }: { where: { dealId_userId: { userId: string } } }) =>
          PARTICIPANTS[where.dealId_userId.userId] ?? null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    deal: {
      findUnique: jest.fn(async () => deal),
      findUniqueOrThrow: jest.fn(async () => deal),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    dueDiligenceItem: {
      count: jest.fn(async ({ where }: { where: { status?: unknown } }) =>
        where.status ? ddCounts.open : ddCounts.total,
      ),
    },
    dealTimelineEvent: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { create: jest.fn() };
  const audit = { record: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new DealsService(prisma as any, notifications as any, audit as any);
  return { service, prisma, tx, deal };
}

describe('DealsService — closing due diligence (DUE_DILIGENCE → AGREEMENT)', () => {
  it('refuses to close due diligence with zero items', async () => {
    const { service, tx } = setup({}, { total: 0, open: 0 });
    await expect(
      service.updateStatus(buyer, 'deal-1', { status: 'AGREEMENT' }),
    ).rejects.toMatchObject(errorCode('DUE_DILIGENCE_NO_ITEMS'));
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });

  it('refuses while any item is still open', async () => {
    const { service } = setup({}, { total: 3, open: 1 });
    await expect(
      service.updateStatus(buyer, 'deal-1', { status: 'AGREEMENT' }),
    ).rejects.toMatchObject(errorCode('DUE_DILIGENCE_ITEMS_OPEN'));
  });

  it('lets the buyer close once every item is closed', async () => {
    const { service, tx } = setup({}, { total: 2, open: 0 });
    await service.updateStatus(buyer, 'deal-1', { status: 'AGREEMENT' });
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: 'deal-1', status: 'DUE_DILIGENCE' },
      data: { status: 'AGREEMENT' },
    });
  });

  it('only the buyer can close due diligence', async () => {
    const { service } = setup({}, { total: 2, open: 0 });
    await expect(
      service.updateStatus(seller, 'deal-1', { status: 'AGREEMENT' }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
    await expect(
      service.updateStatus(advisor, 'deal-1', { status: 'AGREEMENT' }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
  });

  it('a party cannot force the payment-driven stages', async () => {
    const { service } = setup({ status: 'TRANSACTION' });
    await expect(
      service.updateStatus(buyer, 'deal-1', { status: 'TRANSFER' }),
    ).rejects.toMatchObject(errorCode('DEAL_INVALID_STATE_TRANSITION'));
  });

  it('an admin may move any edge the state machine allows', async () => {
    const { service, tx } = setup({ status: 'TRANSACTION' });
    await service.updateStatus(admin, 'deal-1', { status: 'TRANSFER' });
    expect(tx.deal.updateMany).toHaveBeenCalled();
  });
});

describe('DealsService.signNda', () => {
  it('only buyer and seller sign', async () => {
    const { service } = setup({ status: 'NDA' });
    await expect(service.signNda(advisor, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('rejects outside the NDA stage', async () => {
    const { service } = setup({ status: 'INITIATED' });
    await expect(service.signNda(buyer, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });

  it('moves to due diligence once nobody is left unsigned', async () => {
    const { service, prisma, tx } = setup({ status: 'NDA' });
    prisma.dealParticipant.count.mockResolvedValue(0);
    await service.signNda(seller, 'deal-1');
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: 'deal-1', status: 'NDA' },
      data: { status: 'DUE_DILIGENCE' },
    });
  });
});

describe('DealsService — transfer and receipt', () => {
  it('only the seller confirms the transfer', async () => {
    const { service } = setup({ status: 'TRANSFER' });
    await expect(service.confirmTransfer(buyer, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('confirm-transfer requires the TRANSFER stage', async () => {
    const { service } = setup({ status: 'TRANSACTION' });
    await expect(service.confirmTransfer(seller, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });

  it('only the buyer confirms receipt, and only after the seller', async () => {
    const pending = setup({ status: 'TRANSFER' });
    await expect(pending.service.confirmReceipt(seller, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
    await expect(pending.service.confirmReceipt(buyer, 'deal-1')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });

  it('receipt completes the deal and marks the business and listing SOLD', async () => {
    const { service, tx } = setup({ status: 'TRANSFER', sellerTransferConfirmedAt: new Date() });
    await service.confirmReceipt(buyer, 'deal-1');
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: 'deal-1', status: 'TRANSFER' },
      data: { status: 'COMPLETED' },
    });
    expect(tx.business.update).toHaveBeenCalledWith({
      where: { id: 'biz-1' },
      data: { status: 'SOLD' },
    });
    expect(tx.businessListing.updateMany).toHaveBeenCalledWith({
      where: { businessId: 'biz-1' },
      data: { status: 'SOLD' },
    });
  });
});

describe('DealsService.getOne', () => {
  it('returns the agreed price as JSON-safe major units', async () => {
    const { service, prisma } = setup();
    (prisma.deal.findUnique as jest.Mock).mockResolvedValue({
      id: 'deal-1',
      acceptedOffer: { amountMinor: 5_000_000n, currency: 'USD' },
    });
    const deal = await service.getOne(buyer, 'deal-1');
    expect(deal?.acceptedOffer).toEqual({ amount: 50000, currency: 'USD' });
    expect(() => JSON.stringify(deal)).not.toThrow();
  });
});
