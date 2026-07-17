import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module';
import { FinancialAccountsService } from './financial-accounts.service';
import { FinancialAccountsController } from './financial-accounts.controller';
import { GenericCsvParser } from './statement-parsing/generic-csv.parser';
import { StatementImportsService } from './statement-imports.service';
import { StatementImportsController } from './statement-imports.controller';
import { MatchingService } from './matching.service';
import { MatchesService } from './matches.service';
import { MatchesController } from './matches.controller';
import { MatchRulesService } from './match-rules.service';
import { MatchRulesController } from './match-rules.controller';
import { ReconciliationSessionsService } from './reconciliation-sessions.service';
import { ReconciliationSessionsController } from './reconciliation-sessions.controller';
import { ReconciliationReportRenderer } from './reconciliation-report.renderer';
import { ReconciliationReportController } from './reconciliation-report.controller';
import { MomoWebhookService } from './momo-webhook.service';
import { MomoWebhookController } from './momo-webhook.controller';

@Module({
  imports: [JournalModule],
  providers: [
    FinancialAccountsService,
    GenericCsvParser,
    StatementImportsService,
    MatchingService,
    MatchesService,
    MatchRulesService,
    ReconciliationSessionsService,
    ReconciliationReportRenderer,
    MomoWebhookService,
  ],
  controllers: [
    FinancialAccountsController,
    StatementImportsController,
    MatchesController,
    MatchRulesController,
    ReconciliationSessionsController,
    ReconciliationReportController,
    MomoWebhookController,
  ],
  exports: [FinancialAccountsService, MatchingService],
})
export class ReconciliationModule {}
