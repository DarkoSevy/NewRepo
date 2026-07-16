import { Module } from '@nestjs/common';
import { BillsService } from './bills.service';
import { BillsController } from './bills.controller';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { EbmModule } from '../ebm/ebm.module';
import { JournalModule } from '../journal/journal.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [EbmModule, JournalModule, InventoryModule],
  providers: [BillsService, ExpensesService],
  controllers: [BillsController, ExpensesController],
  exports: [BillsService, ExpensesService],
})
export class ApModule {}
