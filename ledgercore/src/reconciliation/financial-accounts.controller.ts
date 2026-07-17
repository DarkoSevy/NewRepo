import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { StatementLineStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { FinancialAccountsService } from './financial-accounts.service';
import { CreateFinancialAccountDto } from './dto/create-financial-account.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('financial-accounts')
export class FinancialAccountsController {
  constructor(private readonly accounts: FinancialAccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.accounts.list(user.tenantId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.accounts.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFinancialAccountDto) {
    return this.accounts.create(user, dto);
  }

  @Post(':id/archive')
  @Roles('OWNER', 'ACCOUNTANT')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.accounts.archive(user, id);
  }

  @Get(':id/register')
  register(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('status') status?: StatementLineStatus) {
    return this.accounts.register(user.tenantId, id, { status });
  }

  @Get(':id/clearing-health')
  clearingHealth(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Query('alertThresholdDays') alertThresholdDays?: string) {
    return this.accounts.clearingHealth(user.tenantId, id, alertThresholdDays ? Number(alertThresholdDays) : undefined);
  }
}
