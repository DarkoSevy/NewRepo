import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { ReconciliationSessionsService } from './reconciliation-sessions.service';
import { OpenReconciliationSessionDto } from './dto/open-reconciliation-session.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reconciliation-sessions')
export class ReconciliationSessionsController {
  constructor(private readonly sessions: ReconciliationSessionsService) {}

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  open(@CurrentUser() user: AuthenticatedUser, @Body() dto: OpenReconciliationSessionDto) {
    return this.sessions.open(user, dto.financialAccountId, dto);
  }

  @Get(':id/status')
  status(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.sessions.status(user.tenantId, id);
  }

  @Post(':id/complete')
  @Roles('OWNER', 'ACCOUNTANT')
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.sessions.complete(user, id);
  }

  @Post(':id/reopen')
  @Roles('OWNER')
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.sessions.reopen(user, id);
  }
}
