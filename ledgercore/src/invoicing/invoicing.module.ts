import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { CreditNotesService } from './credit-notes.service';
import { CreditNotesController } from './credit-notes.controller';
import { ReceiptRenderer } from './receipt-renderer';
import { EbmModule } from '../ebm/ebm.module';
import { JournalModule } from '../journal/journal.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [EbmModule, JournalModule, InventoryModule],
  providers: [InvoicesService, CreditNotesService, ReceiptRenderer],
  controllers: [InvoicesController, CreditNotesController],
  exports: [InvoicesService, CreditNotesService],
})
export class InvoicingModule {}
