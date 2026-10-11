import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  BusinessConversationsController,
  ConversationsController,
} from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [NotificationsModule],
  controllers: [ConversationsController, BusinessConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
