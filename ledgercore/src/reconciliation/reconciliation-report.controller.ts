import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { ReconciliationSessionsService } from './reconciliation-sessions.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports/reconciliation')
export class ReconciliationReportController {
  constructor(private readonly sessions: ReconciliationSessionsService) {}

  @Get(':sessionId')
  async report(@CurrentUser() user: AuthenticatedUser, @Param('sessionId') sessionId: string, @Res() res: Response) {
    const pdf = await this.sessions.reportPdf(user.tenantId, sessionId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reconciliation-${sessionId}.pdf"`);
    res.send(pdf);
  }
}
