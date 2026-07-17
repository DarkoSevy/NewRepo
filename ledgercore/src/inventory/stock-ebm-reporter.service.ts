import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EbmService } from '../ebm/ebm.service';

/**
 * Nightly EBM stock reporter (spec §6/§9): pushes every unreported
 * stock_movement (`ebm_reported_at IS NULL`) to the VSDC. Each movement is
 * fetched and marked in its own transaction, so a crash mid-batch — or a
 * rerun for any other reason — only ever reports the movements still
 * outstanding; nothing already marked gets re-sent. There's no scheduler
 * wired up here (no cron infra in this build) — call `runOnce` from
 * whatever trigger you add (cron, queue, admin endpoint).
 */
@Injectable()
export class StockEbmReporterService {
  private readonly logger = new Logger(StockEbmReporterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ebm: EbmService,
  ) {}

  async runOnce(tenantId: string): Promise<{ reported: number; skipped: number }> {
    const tenant = await this.prisma.forTenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
    if (tenant.ebmMode !== 'VSDC') return { reported: 0, skipped: 0 };

    const pending = await this.prisma.forTenant(tenantId, (tx) =>
      tx.stockMovement.findMany({
        where: { tenantId, ebmReportedAt: null },
        include: { item: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

    let reported = 0;
    let skipped = 0;

    for (const movement of pending) {
      if (!movement.item.rraItemCode) {
        this.logger.warn(`Skipping stock_movement ${movement.id}: item ${movement.item.sku} has no rraItemCode yet`);
        skipped++;
        continue;
      }

      const settled = await this.prisma.forTenant(tenantId, async (tx) => {
        // Re-check under this transaction — another run/process may have already reported it.
        const current = await tx.stockMovement.findUnique({ where: { id: movement.id } });
        if (!current || current.ebmReportedAt) return true;

        const result = await this.ebm.reportStockMovement(tx, tenantId, tenant.ebmMode, {
          rraItemCode: movement.item.rraItemCode!,
          movementType: movement.movementType,
          qtyDelta: movement.qtyDelta.toString(),
          unitCostMinor: movement.unitCostMinor.toString(),
          movementDate: movement.createdAt.toISOString(),
        });

        if (result.outcome === 'OK') {
          await tx.stockMovement.update({ where: { id: movement.id }, data: { ebmReportedAt: new Date() } });
          return true;
        }
        return false; // RETRYABLE or FATAL — leave ebm_reported_at null for the next run
      });

      if (settled) reported++;
      else skipped++;
    }

    return { reported, skipped };
  }
}
