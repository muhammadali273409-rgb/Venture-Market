import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

@Injectable()
export class EmailService {
  constructor(@Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider) {}

  // `frontendUrl` is FRONTEND_URL; the pages live at /verify-email and
  // /reset-password (the frontend's (auth) route group adds no URL segment).
  sendVerificationEmail(to: string, token: string, frontendUrl: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'Почтаи худро тасдиқ кунед · Verify your VentureMarket account',
      template: 'verification',
      variables: {
        link: `${trimSlash(frontendUrl)}/verify-email?token=${encodeURIComponent(token)}`,
      },
    });
  }

  sendPasswordResetEmail(to: string, token: string, frontendUrl: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'Барқарор кардани парол · Reset your VentureMarket password',
      template: 'password-reset',
      variables: {
        link: `${trimSlash(frontendUrl)}/reset-password?token=${encodeURIComponent(token)}`,
      },
    });
  }

  sendNewOfferEmail(to: string, businessName: string): Promise<void> {
    return this.provider.send({
      to,
      subject: `New offer on ${businessName}`,
      template: 'new-offer',
      variables: { businessName },
    });
  }

  sendCounterOfferEmail(to: string, businessName: string): Promise<void> {
    return this.provider.send({
      to,
      subject: `Counter-offer on ${businessName}`,
      template: 'counter-offer',
      variables: { businessName },
    });
  }

  sendNewMessageEmail(to: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'New message on VentureMarket',
      template: 'message',
      variables: {},
    });
  }

  sendDealUpdateEmail(to: string, dealId: string, status: string): Promise<void> {
    return this.provider.send({
      to,
      subject: 'Deal update',
      template: 'deal-update',
      variables: { dealId, status },
    });
  }

  sendDocumentRequestEmail(to: string, businessName: string): Promise<void> {
    return this.provider.send({
      to,
      subject: `Document requested for ${businessName}`,
      template: 'document-request',
      variables: { businessName },
    });
  }

  sendGenericNotificationEmail(to: string, title: string, body?: string): Promise<void> {
    return this.provider.send({
      to,
      subject: title,
      template: 'notification',
      variables: { title, body: body ?? '' },
    });
  }
}
