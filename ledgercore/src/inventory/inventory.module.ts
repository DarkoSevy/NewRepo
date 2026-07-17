import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module';
import { EbmModule } from '../ebm/ebm.module';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
import { StockEbmReporterService } from './stock-ebm-reporter.service';

@Module({
  imports: [JournalModule, EbmModule],
  providers: [StockService, StockEbmReporterService],
  controllers: [StockController],
  exports: [StockService, StockEbmReporterService],
})
export class InventoryModule {}
