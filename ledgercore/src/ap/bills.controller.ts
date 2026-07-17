import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BillStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get('bills')
  list(@CurrentUser() user: AuthenticatedUser, @Query('status') status?: BillStatus) {
    return this.bills.list(user.tenantId, { status });
  }

  @Get('bills/:id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bills.findOne(user.tenantId, id);
  }

  @Post('bills')
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateBillDto) {
    return this.bills.create(user, dto);
  }

  @Post('bills/:id/approve')
  @Roles('OWNER', 'ACCOUNTANT')
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bills.approve(user, id);
  }

  @Post('ebm/sync-purchases')
  @Roles('OWNER', 'ACCOUNTANT')
  syncPurchases(@CurrentUser() user: AuthenticatedUser) {
    return this.bills.syncFromEbm(user);
  }
}
