import { DueDiligenceService } from './due-diligence.service';
import { DealsService } from '../deals/deals.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const buyer: AuthenticatedUser = { id: 'buyer-1', email: 'b@example.com', role: 'BUYER' };
const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const lawyer: AuthenticatedUser = { id: 'law-1', email: 'l@example.com', role: 'BUYER' };

const ROLES: Record<string, string> = {
  [buyer.id]: 'BUYER',
  [seller.id]: 'SELLER',
  [lawyer.id]: 'LAWYER',
};

function errorCode(code: string) {
  return { response: { error: expect.objectContaining({ code }) } };
}

function setup(dealStatus = 'DUE_DILIGENCE', item: Record<string, unknown> | null = {}) {
  const deal = { id: 'deal-1', businessId: 'biz-1', status: dealStatus };
  const prisma = {
    dealParticipant: {
      findUnique: jest.fn(async ({ where }: { where: { dealId_userId: { userId: string } } }) => {
        const role = ROLES[where.dealId_userId.userId];
        return role ? { id: `p-${role}`, role } : null;
      }),
      findMany: jest.fn().mockResolvedValue([{ userId: buyer.id }]),
    },
    deal: { findUnique: jest.fn(async () => deal) },
    dueDiligenceRequest: {
      create: jest.fn(async ({ data }) => ({ id: 'req-1', ...data, items: [] })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    dueDiligenceItem: {
      findFirst: jest.fn(async () =>
        item ? { id: 'item-1', documentId: null, response: null, ...item } : null,
      ),
      update: jest.fn(async ({ data }) => ({ id: 'item-1', ...data })),
    },
    businessDocument: {
      findFirst: jest.fn().mockResolvedValue({ id: 'doc-1', businessId: 'biz-1', dealId: null }),
    },
    documentAccess: { upsert: jest.fn() },
    documentAccessLog: { create: jest.fn() },
    dealTimelineEvent: { create: jest.fn() },
  };
  const notifications = { create: jest.fn() };
  const audit = { record: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deals = new DealsService(prisma as any, notifications as any, audit as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new DueDiligenceService(prisma as any, deals, notifications as any);
  return { service, prisma };
}

describe('DueDiligenceService.createRequest', () => {
  const dto = { category: 'FINANCIAL' as const, title: 'P&L', items: ['2025 P&L'] };

  it('lets the buyer request items during due diligence', async () => {
    const { service, prisma } = setup();
    await service.createRequest(buyer, 'deal-1', dto);
    expect(prisma.dueDiligenceRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ items: { create: [{ description: '2025 P&L' }] } }),
      }),
    );
  });

  it('refuses the seller side', async () => {
    const { service } = setup();
    await expect(service.createRequest(seller, 'deal-1', dto)).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('refuses outside the DUE_DILIGENCE stage', async () => {
    const { service } = setup('AGREEMENT');
    await expect(service.createRequest(buyer, 'deal-1', dto)).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });
});

describe('DueDiligenceService.updateItemStatus', () => {
  it('seller answers with text and a document; the document is shared with the buyer', async () => {
    const { service, prisma } = setup();
    await service.updateItemStatus(seller, 'deal-1', 'item-1', {
      status: 'UPLOADED',
      response: '  Attached the 2025 P&L ',
      documentId: 'doc-1',
    });
    expect(prisma.dueDiligenceItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'UPLOADED', documentId: 'doc-1', response: 'Attached the 2025 P&L' },
    });
    expect(prisma.documentAccess.upsert).toHaveBeenCalled();
  });

  it('seller cannot send an empty answer', async () => {
    const { service } = setup();
    await expect(
      service.updateItemStatus(seller, 'deal-1', 'item-1', { status: 'UPLOADED', response: ' ' }),
    ).rejects.toMatchObject(errorCode('VALIDATION_ERROR'));
  });

  it('seller cannot approve their own answer', async () => {
    const { service } = setup();
    await expect(
      service.updateItemStatus(seller, 'deal-1', 'item-1', { status: 'APPROVED' }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
  });

  it('buyer marks an item done but cannot answer it or attach documents', async () => {
    const { service, prisma } = setup();
    await service.updateItemStatus(buyer, 'deal-1', 'item-1', { status: 'COMPLETED' });
    expect(prisma.dueDiligenceItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { status: 'COMPLETED', documentId: undefined, response: undefined },
    });
    await expect(
      service.updateItemStatus(buyer, 'deal-1', 'item-1', { status: 'UPLOADED' }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
    await expect(
      service.updateItemStatus(buyer, 'deal-1', 'item-1', {
        status: 'COMPLETED',
        response: 'x',
      }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
  });

  it('a lawyer (neither side) cannot update items', async () => {
    const { service } = setup();
    await expect(
      service.updateItemStatus(lawyer, 'deal-1', 'item-1', { status: 'COMPLETED' }),
    ).rejects.toMatchObject(errorCode('DEAL_ACCESS_DENIED'));
  });

  it('items of another deal are not found', async () => {
    const { service } = setup('DUE_DILIGENCE', null);
    await expect(
      service.updateItemStatus(buyer, 'deal-1', 'item-x', { status: 'COMPLETED' }),
    ).rejects.toMatchObject(errorCode('NOT_FOUND'));
  });

  it('refuses outside the DUE_DILIGENCE stage', async () => {
    const { service } = setup('AGREEMENT');
    await expect(
      service.updateItemStatus(buyer, 'deal-1', 'item-1', { status: 'COMPLETED' }),
    ).rejects.toMatchObject(errorCode('DEAL_INVALID_STATE_TRANSITION'));
  });
});
