import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { ReportsService } from './reports.service';
import { toCsv } from './csv.util';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('trial-balance')
  async trialBalance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('as_of') asOf: string | undefined,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.trialBalance(user.tenantId, asOf ? new Date(asOf) : new Date());
    if (format === 'csv') {
      return sendCsv(res, 'trial-balance.csv', result.accounts);
    }
    return result;
  }

  @Get('account-ledger/:accountId')
  async accountLedger(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId') accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.accountLedger(
      user.tenantId,
      accountId,
      new Date(from),
      new Date(to),
    );
    if (format === 'csv') {
      return sendCsv(res, 'account-ledger.csv', result.lines);
    }
    return result;
  }

  @Get('general-journal')
  async generalJournal(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.reports.generalJournal(user.tenantId, new Date(from), new Date(to));
    if (format === 'csv') {
      return sendCsv(res, 'general-journal.csv', result);
    }
    return result;
  }
}

function sendCsv(res: Response, filename: string, rows: Record<string, unknown>[]) {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return toCsv(rows);
}
