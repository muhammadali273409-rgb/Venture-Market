import { Module } from '@nestjs/common';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [VerificationController],
  providers: [VerificationService],
})
export class VerificationModule {}
