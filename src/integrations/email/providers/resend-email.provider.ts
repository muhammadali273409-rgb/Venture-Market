import { Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from '../email-provider.interface';
import { renderEmail } from '../email-templates';

/**
 * https://resend.com — EMAIL_PROVIDER=resend. Note: until you verify a
 * domain in Resend, it only delivers to your own Resend account address.
 */
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger('ResendEmailProvider');

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const { subject, html, text } = renderEmail(message);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend rejected email (${res.status}): ${detail.slice(0, 300)}`);
    }
    this.logger.log(`[email:${message.template}] sent to ${message.to}`);
  }
}
