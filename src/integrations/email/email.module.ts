import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfiguration } from '../../config/configuration';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';
import { ConsoleEmailProvider } from './providers/console-email.provider';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { BrevoEmailProvider } from './providers/brevo-email.provider';
import { EmailService } from './email.service';

@Module({
  providers: [
    EmailService,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfiguration, true>): EmailProvider => {
        const { provider, apiKey, from } = config.get('email', { infer: true });
        switch (provider) {
          case 'resend':
            return new ResendEmailProvider(apiKey, from);
          case 'brevo':
            return new BrevoEmailProvider(apiKey, from);
          case 'smtp':
            new Logger('EmailModule').warn(
              'EMAIL_PROVIDER=smtp is not implemented — emails are only logged. Use "resend" or "brevo".',
            );
            return new ConsoleEmailProvider();
          default:
            return new ConsoleEmailProvider();
        }
      },
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
