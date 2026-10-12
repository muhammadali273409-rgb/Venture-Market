import { EmailService } from './email.service';
import { EmailMessage } from './email-provider.interface';
import { parseFromAddress, renderEmail } from './email-templates';

const FRONTEND = 'https://front-for-vernuture-market-production.up.railway.app/';

function setup() {
  const sent: EmailMessage[] = [];
  const service = new EmailService({ send: async (m) => void sent.push(m) });
  return { service, sent };
}

describe('EmailService links', () => {
  it('points the verification link at the frontend /verify-email page', async () => {
    const { service, sent } = setup();
    await service.sendVerificationEmail('a@example.com', 'tok+/=', FRONTEND);
    expect(sent[0].variables.link).toBe(
      'https://front-for-vernuture-market-production.up.railway.app/verify-email?token=tok%2B%2F%3D',
    );
  });

  it('points the reset link at the frontend /reset-password page', async () => {
    const { service, sent } = setup();
    await service.sendPasswordResetEmail('a@example.com', 'abc', FRONTEND);
    expect(sent[0].variables.link).toBe(
      'https://front-for-vernuture-market-production.up.railway.app/reset-password?token=abc',
    );
  });
});

describe('renderEmail', () => {
  it('renders the link into html and text and escapes HTML', () => {
    const out = renderEmail({
      to: 'a@example.com',
      subject: 'S',
      template: 'verification',
      variables: { link: 'https://x.test/verify-email?token=a&b="c"' },
    });
    expect(out.text).toContain('https://x.test/verify-email?token=a&b="c"');
    expect(out.html).toContain('token=a&amp;b=&quot;c&quot;');
    expect(out.html).not.toContain('b="c"');
  });

  it('parses "Name <email>" sender addresses', () => {
    expect(parseFromAddress('VentureMarket <hi@vm.tj>')).toEqual({
      name: 'VentureMarket',
      email: 'hi@vm.tj',
    });
    expect(parseFromAddress('hi@vm.tj')).toEqual({ email: 'hi@vm.tj' });
  });
});
