import { Prisma } from '@prisma/client';
import { ConversationsService } from './conversations.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const buyer: AuthenticatedUser = { id: 'buyer-1', email: 'b@example.com', role: 'BUYER' };
const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const outsider: AuthenticatedUser = { id: 'outsider-1', email: 'o@example.com', role: 'BUYER' };

function setup(
  options: { business?: unknown; existingThread?: string | null; participant?: boolean } = {},
) {
  const conversation = {
    id: 'conv-1',
    businessId: 'biz-1',
    buyerId: buyer.id,
    business: { id: 'biz-1', name: 'Acme', slug: 'acme', ownerId: seller.id },
    participants: [],
    messages: [],
  };
  const prisma = {
    business: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.business === undefined ? { id: 'biz-1', ownerId: seller.id } : options.business,
        ),
    },
    conversation: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.existingThread ? { id: options.existingThread } : null),
      findUnique: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(conversation),
      create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      update: jest.fn((args) => ({ op: 'conversation.update', args })),
    },
    conversationParticipant: {
      findUnique: jest.fn().mockResolvedValue(options.participant === false ? null : { id: 'p' }),
      findMany: jest.fn().mockResolvedValue([{ userId: seller.id }]),
      updateMany: jest.fn((args) => ({ op: 'participant.updateMany', args })),
    },
    message: { create: jest.fn((args) => ({ id: 'msg-1', ...args.data })) },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const notifications = { create: jest.fn() };
  const realtime = { emitToUsers: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ConversationsService(prisma as any, notifications as any, realtime as any);
  return { service, prisma, notifications, realtime };
}

describe('ConversationsService.sendMessage', () => {
  it('pushes the stored message live to every participant, sender included', async () => {
    const { service, realtime } = setup();
    const message = await service.sendMessage(buyer, 'conv-1', { body: 'Hello' });
    expect(realtime.emitToUsers).toHaveBeenCalledWith([buyer.id, seller.id], 'message.new', {
      conversationId: 'conv-1',
      message,
    });
  });

  it('does not push anything when the sender is not a participant', async () => {
    const { service, realtime } = setup({ participant: false });
    await expect(service.sendMessage(outsider, 'conv-1', { body: 'Hi' })).rejects.toThrow();
    expect(realtime.emitToUsers).not.toHaveBeenCalled();
  });
});

describe('ConversationsService.startForBusiness', () => {
  it('takes the seller from the business record and creates one thread with both people', async () => {
    const { service, prisma } = setup();
    const result = await service.startForBusiness(buyer, 'biz-1', { message: 'Hi' });

    expect(prisma.business.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'biz-1', status: 'PUBLISHED', deletedAt: null }),
      }),
    );
    const createArgs = prisma.conversation.create.mock.calls[0][0];
    expect(createArgs.data.buyerId).toBe(buyer.id);
    expect(createArgs.data.participants.create.map((p: { userId: string }) => p.userId)).toEqual([
      buyer.id,
      seller.id,
    ]);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: 'conv-1', senderId: buyer.id, body: 'Hi' },
    });
    expect(result).toMatchObject({ id: 'conv-1', created: true, sellerId: seller.id });
  });

  it('reuses the existing thread instead of creating a duplicate', async () => {
    const { service, prisma } = setup({ existingThread: 'conv-1' });
    const result = await service.startForBusiness(buyer, 'biz-1', { message: 'Again' });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('recovers from a concurrent create via the unique index', async () => {
    const { service, prisma } = setup();
    prisma.conversation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    prisma.conversation.findFirst
      .mockResolvedValueOnce(null) // tagged lookup
      .mockResolvedValueOnce(null) // legacy lookup
      .mockResolvedValueOnce({ id: 'conv-1' }); // after the race
    const result = await service.startForBusiness(buyer, 'biz-1', {});
    expect(result).toMatchObject({ id: 'conv-1', created: false });
  });

  it('404s for a business that is not publicly listed (draft, sold, deleted, private)', async () => {
    const { service } = setup({ business: null });
    await expect(service.startForBusiness(buyer, 'biz-1', {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a seller messaging their own listing', async () => {
    const { service } = setup({ business: { id: 'biz-1', ownerId: 'buyer-1' } });
    await expect(service.startForBusiness(buyer, 'biz-1', {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses accounts without a buyer role', async () => {
    const { service, prisma } = setup();
    await expect(service.startForBusiness(seller, 'biz-1', {})).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.business.findFirst).not.toHaveBeenCalled();
  });
});

describe('ConversationsService access control', () => {
  it('a non-participant cannot read messages, send, or open the conversation', async () => {
    const { service, prisma } = setup({ participant: false });
    await expect(service.listMessages(outsider, 'conv-1', {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.sendMessage(outsider, 'conv-1', { body: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.getForUser(outsider, 'conv-1')).rejects.toMatchObject({ status: 403 });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('a participant sends as themselves — the sender is never taken from input', async () => {
    const { service, prisma, notifications } = setup();
    prisma.conversationParticipant.findMany.mockResolvedValueOnce([{ userId: buyer.id }]);
    await service.sendMessage(seller, 'conv-1', { body: 'Hello buyer' });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: 'conv-1', senderId: seller.id, body: 'Hello buyer' },
    });
    expect(prisma.conversationParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv-1', userId: { not: seller.id } } }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: buyer.id, type: 'NEW_MESSAGE' }),
    );
  });

  it('legacy POST /conversations about a listing is routed through the seller-derived path', async () => {
    const { service, prisma } = setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.business as any).findUnique = jest
      .fn()
      .mockResolvedValue({ ownerId: seller.id, deletedAt: null });
    const result = await service.create(buyer, {
      participantIds: [seller.id],
      businessId: 'c0a80101-0000-4000-8000-000000000001',
      initialMessage: 'Hi',
    });
    expect(result.created).toBe(true);
    expect(prisma.conversation.create.mock.calls[0][0].data.buyerId).toBe(buyer.id);
  });
});
