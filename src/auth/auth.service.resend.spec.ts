import { AuthService } from './auth.service';

function setup(options: { user?: Record<string, unknown> | null; recentToken?: boolean } = {}) {
  const user =
    options.user === undefined
      ? { id: 'u1', email: 'samir21@example.com', deletedAt: null, emailVerifiedAt: null }
      : options.user;
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    emailVerificationToken: {
      findFirst: jest.fn().mockResolvedValue(options.recentToken ? { id: 't' } : null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
    },
  };
  const email = { sendVerificationEmail: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (key: string) => (key === 'frontendUrl' ? 'https://front.example' : undefined),
  };
  const service = new AuthService(
    /* eslint-disable @typescript-eslint/no-explicit-any */
    prisma as any,
    {} as any,
    {} as any,
    config as any,
    email as any,
    {} as any,
    /* eslint-enable @typescript-eslint/no-explicit-any */
  );
  return { service, prisma, email };
}

describe('AuthService.resendVerification', () => {
  it('invalidates old links and emails a new one to the frontend URL', async () => {
    const { service, prisma, email } = setup();
    await service.resendVerification('samir21@example.com');
    expect(prisma.emailVerificationToken.updateMany).toHaveBeenCalled();
    expect(prisma.emailVerificationToken.create).toHaveBeenCalled();
    expect(email.sendVerificationEmail).toHaveBeenCalledWith(
      'samir21@example.com',
      expect.any(String),
      'https://front.example',
    );
  });

  it('does nothing (and reveals nothing) for an unknown email', async () => {
    const { service, email } = setup({ user: null });
    await expect(service.resendVerification('nobody@example.com')).resolves.toBeUndefined();
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('does nothing for an already verified account', async () => {
    const { service, email } = setup({
      user: { id: 'u1', email: 'a@example.com', deletedAt: null, emailVerifiedAt: new Date() },
    });
    await service.resendVerification('a@example.com');
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('sends at most one email per minute', async () => {
    const { service, email } = setup({ recentToken: true });
    await service.resendVerification('samir21@example.com');
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('does not throw when the email provider fails', async () => {
    const { service, email } = setup();
    email.sendVerificationEmail.mockRejectedValueOnce(new Error('provider down'));
    await expect(service.resendVerification('samir21@example.com')).resolves.toBeUndefined();
  });
});
