import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [StorageModule],
  controllers: [ListingsController],
  providers: [ListingsService],
})
export class ListingsModule {}
