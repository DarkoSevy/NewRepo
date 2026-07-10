import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AccountsModule } from './accounts/accounts.module';
import { PeriodsModule } from './periods/periods.module';
import { JournalModule } from './journal/journal.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    TenancyModule,
    AccountsModule,
    PeriodsModule,
    JournalModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
