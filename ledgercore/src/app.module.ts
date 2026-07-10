import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AccountsModule } from './accounts/accounts.module';
import { PeriodsModule } from './periods/periods.module';
import { JournalModule } from './journal/journal.module';
import { ReportsModule } from './reports/reports.module';
import { TaxModule } from './tax/tax.module';
import { ContactsModule } from './contacts/contacts.module';
import { EbmModule } from './ebm/ebm.module';
import { ItemsModule } from './items/items.module';
import { InvoicingModule } from './invoicing/invoicing.module';
import { ApModule } from './ap/ap.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    AuditModule,
    TaxModule,
    AuthModule,
    TenancyModule,
    AccountsModule,
    PeriodsModule,
    JournalModule,
    ReportsModule,
    ContactsModule,
    EbmModule,
    ItemsModule,
    InvoicingModule,
    ApModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
