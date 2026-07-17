import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { ControlAccountsService } from '../common/control-accounts.service';
import { StockService } from './stock.service';
import { StockEbmReporterService } from './stock-ebm-reporter.service';
import { OpeningBalanceDto } from './dto/opening-balance.dto';
import { StockAdjustmentDto } from './dto/stock-adjustment.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stock')
export class StockController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly controlAccounts: ControlAccountsService,
    private readonly stock: StockService,
    private readonly ebmReporter: StockEbmReporterService,
  ) {}

  @Post('opening-balances')
  @Roles('OWNER', 'ACCOUNTANT')
  openingBalance(@CurrentUser() user: AuthenticatedUser, @Body() dto: OpeningBalanceDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const item = await tx.item.findUnique({ where: { id: dto.itemId } });
      if (!item) throw new NotFoundException('Item not found');
      if (!item.inventoryAccountId) throw new BadRequestException(`Item ${item.sku} has no inventory account configured`);

      const result = await this.stock.setOpeningBalance(tx, user.tenantId, dto.itemId, dto.qty, BigInt(dto.unitCostMinor));

      const retainedEarnings = await tx.account.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: '3100' } } });
      if (!retainedEarnings) throw new BadRequestException('Retained Earnings account (3100) not found — seed the rw-sme template first');

      await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: new Date(),
        memo: `Opening stock balance for ${item.sku}`,
        sourceDocumentRef: { type: 'STOCK_OPENING_BALANCE', id: dto.itemId },
        lines: [
          { accountId: item.inventoryAccountId, direction: 'DEBIT', amountMinor: result.valueMinor, currency: 'RWF' },
          { accountId: retainedEarnings.id, direction: 'CREDIT', amountMinor: result.valueMinor, currency: 'RWF' },
        ],
        actorId: user.userId,
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'STOCK_OPENING_BALANCE_SET',
        entity: 'item',
        entityId: dto.itemId,
        payload: { qty: dto.qty, unitCostMinor: dto.unitCostMinor },
      });

      return result;
    });
  }

  @Post('adjustments')
  @Roles('OWNER', 'ACCOUNTANT')
  adjustment(@CurrentUser() user: AuthenticatedUser, @Body() dto: StockAdjustmentDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const item = await tx.item.findUnique({ where: { id: dto.itemId } });
      if (!item) throw new NotFoundException('Item not found');
      if (!item.inventoryAccountId) throw new BadRequestException(`Item ${item.sku} has no inventory account configured`);

      const result = await this.stock.recordAdjustment(tx, user.tenantId, dto.itemId, dto.qtyDelta, dto.reason);
      const adjustmentAccountId = await this.controlAccounts.resolve(tx, user.tenantId, 'INVENTORY_ADJUSTMENT');

      if (result.valueDeltaMinor !== 0n) {
        const positive = result.valueDeltaMinor > 0n;
        const amount = positive ? result.valueDeltaMinor : -result.valueDeltaMinor;
        await this.journal.postSystemEntry(tx, {
          tenantId: user.tenantId,
          entryDate: new Date(),
          memo: `Stocktake adjustment: ${dto.reason}`,
          sourceDocumentRef: { type: 'STOCK_ADJUSTMENT', id: dto.itemId },
          lines: positive
            ? [
                { accountId: item.inventoryAccountId, direction: 'DEBIT', amountMinor: amount, currency: 'RWF' },
                { accountId: adjustmentAccountId, direction: 'CREDIT', amountMinor: amount, currency: 'RWF' },
              ]
            : [
                { accountId: adjustmentAccountId, direction: 'DEBIT', amountMinor: amount, currency: 'RWF' },
                { accountId: item.inventoryAccountId, direction: 'CREDIT', amountMinor: amount, currency: 'RWF' },
              ],
          actorId: user.userId,
        });
      }

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'STOCK_ADJUSTED',
        entity: 'item',
        entityId: dto.itemId,
        payload: { qtyDelta: dto.qtyDelta, reason: dto.reason },
      });

      return result;
    });
  }

  /** Manual trigger for the "nightly" EBM stock reporter — see StockEbmReporterService for the scheduling note. */
  @Post('ebm-report-movements')
  @Roles('OWNER', 'ACCOUNTANT')
  reportMovements(@CurrentUser() user: AuthenticatedUser) {
    return this.ebmReporter.runOnce(user.tenantId);
  }
}
