import { Module } from '@nestjs/common';
import { DealsModule } from '../deals/deals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  AdminTransactionsController,
  PaymentsConfigController,
  TransactionsController,
} from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [DealsModule, NotificationsModule],
  controllers: [TransactionsController, PaymentsConfigController, AdminTransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
