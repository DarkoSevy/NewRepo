import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { EbmService } from './ebm.service';
import { InitDeviceDto } from './dto/init-device.dto';

const LOCKOUT_HOURS = 24;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class EbmController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ebm: EbmService,
  ) {}

  @Get('rra-codes')
  rraCodes(@CurrentUser() user: AuthenticatedUser, @Query('type') type?: string) {
    return this.prisma.forTenant(user.tenantId, (tx) =>
      tx.rraCode.findMany({ where: { codeType: type }, orderBy: [{ codeType: 'asc' }, { code: 'asc' }] }),
    );
  }

  @Post('ebm/sync-codes')
  @Roles('OWNER', 'ACCOUNTANT')
  async syncCodes(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      return this.ebm.syncCodes(tx, user.tenantId, tenant.ebmMode);
    });
  }

  // /ebm/sync-purchases lives on BillsController (ap/bills.controller.ts) —
  // it needs to turn synced purchases into DRAFT bills, not just log them.

  @Post('ebm/device')
  @Roles('OWNER')
  async initDevice(@CurrentUser() user: AuthenticatedUser, @Body() dto: InitDeviceDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      return this.ebm.initDevice(tx, user.tenantId, tenant.ebmMode, dto);
    });
  }

  @Get('ebm/health')
  async health(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const device = await tx.ebmDevice.findUnique({ where: { tenantId: user.tenantId } });
      const queueDepth = await tx.invoice.count({ where: { tenantId: user.tenantId, status: 'CERTIFYING' } });

      if (tenant.ebmMode === 'DISABLED') {
        return { ebmMode: tenant.ebmMode, locked: false, queueDepth, lastSuccessfulSyncAt: null, hoursRemaining: null };
      }

      const lastSyncAt = device?.lastSyncAt ?? null;
      const hoursSinceLastSync = lastSyncAt ? (Date.now() - lastSyncAt.getTime()) / 3_600_000 : null;
      const hoursRemaining = hoursSinceLastSync === null ? null : Math.max(0, LOCKOUT_HOURS - hoursSinceLastSync);
      const locked = !device || hoursSinceLastSync === null || hoursSinceLastSync > LOCKOUT_HOURS;

      return {
        ebmMode: tenant.ebmMode,
        deviceConfigured: Boolean(device),
        sdcId: device?.sdcId ?? null,
        lastSuccessfulSyncAt: lastSyncAt,
        hoursRemaining,
        locked,
        queueDepth,
      };
    });
  }
}
