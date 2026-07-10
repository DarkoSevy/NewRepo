import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { PeriodsService } from './periods.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.periods.list(user.tenantId);
  }

  @Post('generate')
  @Roles('OWNER', 'ACCOUNTANT')
  generate(@CurrentUser() user: AuthenticatedUser, @Query('year') year: string) {
    return this.periods.generate(user, parseInt(year, 10));
  }

  @Post(':id/close')
  @Roles('OWNER', 'ACCOUNTANT')
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.periods.close(user, id);
  }

  @Post(':id/reopen')
  @Roles('OWNER')
  reopen(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.periods.reopen(user, id);
  }
}
