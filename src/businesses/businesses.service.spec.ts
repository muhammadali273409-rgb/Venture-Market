import { BusinessesService } from './businesses.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';

const seller: AuthenticatedUser = { id: 'seller-1', email: 's@example.com', role: 'SELLER' };
const otherSeller: AuthenticatedUser = { id: 'seller-2', email: 'o@example.com', role: 'SELLER' };
const admin: AuthenticatedUser = { id: 'admin-1', email: 'a@example.com', role: 'ADMIN' };

function makeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    ownerId: seller.id,
    name: 'Acme',
    description: 'A business',
    categoryId: 'cat-1',
    businessModel: 'SaaS',
    status: 'DRAFT',
    deletedAt: null,
    images: [],
    metrics: [],
    listing: {
      askingPriceMinor: 5_000_000n,
      currency: 'USD',
      visibility: 'PRIVATE',
      publishedAt: null,
    },
    ...overrides,
  };
}

/** AppException keeps the human message under response.error.message. */
function errorMessage(pattern: RegExp) {
  return { response: { error: { message: expect.stringMatching(pattern) } } };
}

function setup(business: Record<string, unknown> | null, activeDeals = 0) {
  const prisma = {
    business: {
      findUnique: jest.fn().mockResolvedValue(business),
      update: jest.fn((args) => ({ op: 'business.update', args })),
    },
    businessListing: { update: jest.fn((args) => ({ op: 'listing.update', args })) },
    businessImage: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn((args) => ({ op: 'image.create', args })),
      deleteMany: jest.fn((args) => ({ op: 'image.deleteMany', args })),
    },
    deal: { count: jest.fn().mockResolvedValue(activeDeals) },
    $transaction: jest.fn(async (ops: unknown[]) =>
      ops.map((op, i) => (i === 0 ? { id: 'biz-1', status: 'PUBLISHED', op } : op)),
    ),
  };
  const storage = {
    getSignedDownloadUrl: jest.fn(async (key: string) => `https://signed/${key}`),
    buildImageKey: jest.fn(() => 'businesses/biz-1/images/key.png'),
    putObject: jest.fn(),
    deleteObject: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const queue = { add: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new BusinessesService(prisma as any, audit as any, storage as any, queue as any);
  return { service, prisma, storage, audit, queue };
}

describe('BusinessesService.publish', () => {
  it('publishes a complete draft straight to the marketplace as PUBLIC', async () => {
    const { service, prisma, queue } = setup(makeBusiness());

    await service.publish(seller, 'biz-1');

    expect(prisma.business.update).toHaveBeenCalledWith({
      where: { id: 'biz-1' },
      data: { status: 'PUBLISHED' },
    });
    const listingData = prisma.businessListing.update.mock.calls[0][0].data;
    expect(listingData.status).toBe('PUBLISHED');
    expect(listingData.visibility).toBe('PUBLIC');
    expect(listingData.publishedAt).toBeInstanceOf(Date);
    expect(queue.add).toHaveBeenCalled();
  });

  it('keeps an explicit UNLISTED visibility', async () => {
    const business = makeBusiness();
    (business.listing as Record<string, unknown>).visibility = 'UNLISTED';
    const { service, prisma } = setup(business);

    await service.publish(seller, 'biz-1');

    expect(prisma.businessListing.update.mock.calls[0][0].data.visibility).toBe('UNLISTED');
  });

  it('refuses an incomplete listing and names the missing fields', async () => {
    const { service, prisma } = setup(
      makeBusiness({
        description: null,
        listing: { askingPriceMinor: null, visibility: 'PRIVATE' },
      }),
    );

    await expect(service.publish(seller, 'biz-1')).rejects.toMatchObject({
      response: { error: { code: 'LISTING_INCOMPLETE' } },
    });
    await expect(service.publish(seller, 'biz-1')).rejects.toMatchObject(
      errorMessage(/description, askingPrice/),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 404 for another seller's business", async () => {
    const { service } = setup(makeBusiness());
    await expect(service.publish(otherSeller, 'biz-1')).rejects.toMatchObject({
      response: { error: { code: 'BUSINESS_NOT_FOUND' } },
    });
  });

  it('lets an admin publish any business', async () => {
    const { service, prisma } = setup(makeBusiness());
    await service.publish(admin, 'biz-1');
    expect(prisma.business.update).toHaveBeenCalled();
  });

  it('refuses a SUSPENDED business', async () => {
    const { service } = setup(makeBusiness({ status: 'SUSPENDED' }));
    await expect(service.publish(seller, 'biz-1')).rejects.toMatchObject({
      response: { error: { code: 'BUSINESS_INVALID_STATE_TRANSITION' } },
    });
  });
});

describe('BusinessesService.softDelete', () => {
  it('soft-deletes a draft and unpublishes its listing', async () => {
    const { service, prisma } = setup(makeBusiness());
    await expect(service.softDelete(seller, 'biz-1')).resolves.toEqual({ success: true });
    expect(prisma.business.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(prisma.businessListing.update.mock.calls[0][0].data.status).toBe('UNPUBLISHED');
  });

  it('requires a seller to unpublish a live listing first', async () => {
    const { service } = setup(makeBusiness({ status: 'PUBLISHED' }));
    await expect(service.softDelete(seller, 'biz-1')).rejects.toMatchObject(
      errorMessage(/Unpublish/),
    );
  });

  it('lets an admin delete a live listing', async () => {
    const { service } = setup(makeBusiness({ status: 'PUBLISHED' }));
    await expect(service.softDelete(admin, 'biz-1')).resolves.toEqual({ success: true });
  });

  it('refuses while a deal is in progress', async () => {
    const { service } = setup(makeBusiness({ status: 'PAUSED' }), 1);
    await expect(service.softDelete(admin, 'biz-1')).rejects.toMatchObject({
      response: { error: { code: 'BUSINESS_LOCKED' } },
    });
  });
});

describe('BusinessesService.uploadImage', () => {
  const png = {
    originalname: 'logo.png',
    mimetype: 'image/png',
    size: 1000,
    buffer: Buffer.from('x'),
  };

  it('rejects non-image files before touching storage', async () => {
    const { service, storage } = setup(makeBusiness());
    await expect(
      service.uploadImage(seller, 'biz-1', { ...png, mimetype: 'image/svg+xml' }),
    ).rejects.toMatchObject(errorMessage(/JPEG, PNG or WebP/));
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('replaces the previous logo', async () => {
    const { service, prisma, storage } = setup(makeBusiness());
    prisma.businessImage.findMany.mockResolvedValue([{ id: 'old-logo', storageKey: 'old-key' }]);
    prisma.$transaction.mockResolvedValue([
      { id: 'new-logo', kind: 'LOGO', storageKey: 'businesses/biz-1/images/key.png', position: 0 },
    ]);

    const image = await service.uploadImage(seller, 'biz-1', png, 'LOGO');

    expect(prisma.businessImage.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-logo'] } },
    });
    expect(storage.deleteObject).toHaveBeenCalledWith('old-key');
    expect(image).toMatchObject({ id: 'new-logo', kind: 'LOGO' });
    expect(image.url).toContain('https://signed/');
  });
});
