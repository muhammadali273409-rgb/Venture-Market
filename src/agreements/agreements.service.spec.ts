import { AgreementsService } from './agreements.service';
import { DealsService } from '../deals/deals.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const buyer: AuthenticatedUser = { id: 'buyer-1', email: 'b@example.com', role: 'BUYER' };
const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const lawyer: AuthenticatedUser = { id: 'law-1', email: 'l@example.com', role: 'BUYER' };
const accountant: AuthenticatedUser = { id: 'acc-1', email: 'a@example.com', role: 'BUYER' };

const ROLES: Record<string, string> = {
  [buyer.id]: 'BUYER',
  [seller.id]: 'SELLER',
  [lawyer.id]: 'LAWYER',
  [accountant.id]: 'ACCOUNTANT',
};

const HASH = 'a'.repeat(64);

function errorCode(code: string) {
  return { response: { error: expect.objectContaining({ code }) } };
}

function setup(
  opts: {
    dealStatus?: string;
    agreementStatus?: string;
    latestVersionId?: string | null;
    signatures?: number;
    document?: Record<string, unknown> | null;
  } = {},
) {
  const {
    dealStatus = 'AGREEMENT',
    agreementStatus = 'PENDING_SIGNATURE',
    latestVersionId = 'v-2',
    signatures = 1,
    document = { id: 'doc-1' },
  } = opts;
  const deal = { id: 'deal-1', businessId: 'biz-1', status: dealStatus };
  const tx = {
    deal: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(async () => ({ ...deal, status: 'TRANSACTION' })),
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
      findMany: jest.fn().mockResolvedValue([{ userId: buyer.id }, { userId: seller.id }]),
    },
    deal: { findUnique: jest.fn(async () => deal) },
    agreement: {
      create: jest.fn(async ({ data }) => ({ id: 'agr-1', ...data })),
      findFirst: jest.fn(async () => ({ id: 'agr-1', dealId: 'deal-1', status: agreementStatus })),
      update: jest.fn(),
    },
    agreementVersion: {
      findFirst: jest.fn(async () =>
        latestVersionId ? { id: latestVersionId, version: 2 } : null,
      ),
      create: jest.fn(async ({ data }) => ({ id: 'v-3', ...data })),
    },
    agreementSignature: {
      upsert: jest.fn(async () => ({ id: 'sig-1' })),
      count: jest.fn().mockResolvedValue(signatures),
    },
    businessDocument: { findFirst: jest.fn().mockResolvedValue(document) },
    dealTimelineEvent: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { create: jest.fn() };
  const audit = { record: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deals = new DealsService(prisma as any, notifications as any, audit as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AgreementsService(prisma as any, deals);
  return { service, prisma, tx };
}

describe('AgreementsService.create', () => {
  it('buyer, seller or a lawyer drafts in the AGREEMENT stage', async () => {
    const { service, prisma } = setup();
    await service.create(lawyer, 'deal-1', { title: 'SPA' });
    expect(prisma.agreement.create).toHaveBeenCalled();
  });

  it('other advisors cannot draft', async () => {
    const { service } = setup();
    await expect(service.create(accountant, 'deal-1', { title: 'SPA' })).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('refuses outside the AGREEMENT stage', async () => {
    const { service } = setup({ dealStatus: 'DUE_DILIGENCE' });
    await expect(service.create(buyer, 'deal-1', { title: 'SPA' })).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });
});

describe('AgreementsService.addVersion', () => {
  it('stores an uploaded deal document with its hash and asks for signatures', async () => {
    const { service, prisma } = setup();
    await service.addVersion(seller, 'deal-1', 'agr-1', {
      documentId: 'doc-1',
      contentHash: HASH.toUpperCase(),
    });
    expect(prisma.businessDocument.findFirst).toHaveBeenCalledWith({
      where: { id: 'doc-1', dealId: 'deal-1', deletedAt: null, visibility: { not: 'PRIVATE' } },
    });
    expect(prisma.agreementVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 3, documentId: 'doc-1', contentHash: HASH }),
    });
    expect(prisma.agreement.update).toHaveBeenCalledWith({
      where: { id: 'agr-1' },
      data: { status: 'PENDING_SIGNATURE' },
    });
  });

  it('needs a file or a link', async () => {
    const { service } = setup();
    await expect(service.addVersion(buyer, 'deal-1', 'agr-1', {})).rejects.toMatchObject(
      errorCode('VALIDATION_ERROR'),
    );
  });

  it('refuses a document that is not part of this deal', async () => {
    const { service } = setup({ document: null });
    await expect(
      service.addVersion(buyer, 'deal-1', 'agr-1', { documentId: 'doc-x' }),
    ).rejects.toMatchObject(errorCode('DOCUMENT_NOT_FOUND'));
  });

  it('a signed agreement cannot get new versions', async () => {
    const { service } = setup({ agreementStatus: 'SIGNED' });
    await expect(
      service.addVersion(buyer, 'deal-1', 'agr-1', { contentUrl: 'https://x.example/a.pdf' }),
    ).rejects.toMatchObject(errorCode('CONFLICT'));
  });
});

describe('AgreementsService.sign', () => {
  it('only buyer and seller sign — not a lawyer', async () => {
    const { service } = setup();
    await expect(service.sign(lawyer, 'deal-1', 'agr-1', 'v-2')).rejects.toMatchObject(
      errorCode('DEAL_ACCESS_DENIED'),
    );
  });

  it('only the latest version can be signed', async () => {
    const { service } = setup();
    await expect(service.sign(buyer, 'deal-1', 'agr-1', 'v-1')).rejects.toMatchObject(
      errorCode('CONFLICT'),
    );
  });

  it('first signature leaves the agreement PARTIALLY_SIGNED and the deal in AGREEMENT', async () => {
    const { service, prisma, tx } = setup({ signatures: 1 });
    await service.sign(buyer, 'deal-1', 'agr-1', 'v-2');
    expect(prisma.agreement.update).toHaveBeenCalledWith({
      where: { id: 'agr-1' },
      data: { status: 'PARTIALLY_SIGNED' },
    });
    expect(tx.deal.updateMany).not.toHaveBeenCalled();
  });

  it('second signature signs the agreement and moves the deal to TRANSACTION', async () => {
    const { service, prisma, tx } = setup({ signatures: 2 });
    await service.sign(seller, 'deal-1', 'agr-1', 'v-2');
    expect(prisma.agreement.update).toHaveBeenCalledWith({
      where: { id: 'agr-1' },
      data: { status: 'SIGNED' },
    });
    expect(tx.deal.updateMany).toHaveBeenCalledWith({
      where: { id: 'deal-1', status: 'AGREEMENT' },
      data: { status: 'TRANSACTION' },
    });
  });

  it('refuses outside the AGREEMENT stage', async () => {
    const { service } = setup({ dealStatus: 'TRANSACTION' });
    await expect(service.sign(buyer, 'deal-1', 'agr-1', 'v-2')).rejects.toMatchObject(
      errorCode('DEAL_INVALID_STATE_TRANSITION'),
    );
  });
});
