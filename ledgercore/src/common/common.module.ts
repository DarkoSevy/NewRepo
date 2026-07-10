import { Global, Module } from '@nestjs/common';
import { DocumentNumberingService } from './document-numbering.service';
import { ControlAccountsService } from './control-accounts.service';

@Global()
@Module({
  providers: [DocumentNumberingService, ControlAccountsService],
  exports: [DocumentNumberingService, ControlAccountsService],
})
export class CommonModule {}
