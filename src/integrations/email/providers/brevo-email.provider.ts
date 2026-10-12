import { Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from '../email-provider.interface';
import { parseFromAddress, renderEmail } from '../email-templates';

/**
 * https://brevo.com — EMAIL_PROVIDER=brevo. Works without owning a domain:
 * the EMAIL_FROM address only has to be a verified sender in Brevo.
 */
export class BrevoEmailProvider implements EmailProvider {
  private readonly logger = new Logger('BrevoEmailProvider');

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const { subject, html, text } = renderEmail(message);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: parseFromAddress(this.from),
        to: [{ email: message.to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Brevo rejected email (${res.status}): ${detail.slice(0, 300)}`);
    }
    this.logger.log(`[email:${message.template}] sent to ${message.to}`);
  }
}
