import { Module } from '@nestjs/common';
import { QueueModule } from '../jobs/queue.module';
import { StorageModule } from '../storage/storage.module';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';

@Module({
  imports: [QueueModule, StorageModule],
  controllers: [BusinessesController],
  providers: [BusinessesService],
  exports: [BusinessesService],
})
export class BusinessesModule {}
