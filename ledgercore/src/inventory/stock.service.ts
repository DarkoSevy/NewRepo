import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { TenantTx } from '../prisma/prisma.service';
import { applyAdjustment, applyPurchase, applySale, bookValueMinor, WacState } from './wac';

export interface StockPostingResult {
  /** Extra Dr/Cr Inventory-vs-Inventory-Adjustment line the caller should fold into its GL entry, if the WAC rounding residue is nonzero. */
  residueMinor: bigint;
  qtyOnHand: Decimal.Value;
  wacMinorX1000: bigint;
}

export interface SalePostingResult extends StockPostingResult {
  cogsMinor: bigint;
}

/**
 * Owns item WAC state and the append-only stock_movements ledger. Callers
 * (BillsService, InvoicesService, the stocktake endpoint) build their own
 * GL entry and fold in whatever this returns — Inventory/COGS/AP lines
 * plus, when nonzero, a residue line to Inventory Adjustment — so the
 * whole thing posts as one atomic SYSTEM entry, not two.
 */
@Injectable()
export class StockService {
  async recordPurchase(
    tx: TenantTx,
    tenantId: string,
    itemId: string,
    qty: Decimal.Value,
    unitCostMinor: bigint,
    sourceDocumentRef: unknown,
  ): Promise<StockPostingResult> {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.tracked) throw new BadRequestException(`Item ${item.sku} is not tracked for inventory`);

    const before: WacState = { qtyOnHand: item.qtyOnHand, wacMinorX1000: item.wacMinor };
    const bookValueBefore = bookValueMinor(before);
    const after = applyPurchase(before, qty, unitCostMinor);

    const qtyMinor = new Decimal(qty).times(unitCostMinor.toString());
    const postedAmount = BigInt(qtyMinor.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
    const bookValueAfter = bookValueMinor(after);
    const residueMinor = bookValueAfter - (bookValueBefore + postedAmount);

    await tx.item.update({ where: { id: itemId }, data: { qtyOnHand: after.qtyOnHand.toString(), wacMinor: after.wacMinorX1000 } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        itemId,
        movementType: 'PURCHASE',
        qtyDelta: new Decimal(qty).toString(),
        unitCostMinor,
        sourceDocumentRef: sourceDocumentRef as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      },
    });

    return { residueMinor, qtyOnHand: after.qtyOnHand, wacMinorX1000: after.wacMinorX1000 };
  }

  async recordSale(
    tx: TenantTx,
    tenantId: string,
    itemId: string,
    qty: Decimal.Value,
    negativeStockPolicy: 'BLOCK' | 'WARN',
    sourceDocumentRef: unknown,
  ): Promise<SalePostingResult> {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.tracked) throw new BadRequestException(`Item ${item.sku} is not tracked for inventory`);

    const before: WacState = { qtyOnHand: item.qtyOnHand, wacMinorX1000: item.wacMinor };
    const qtyOutD = new Decimal(qty);
    if (qtyOutD.greaterThan(item.qtyOnHand)) {
      const shortfall = qtyOutD.minus(item.qtyOnHand);
      if (negativeStockPolicy === 'BLOCK') {
        throw new BadRequestException(`Insufficient stock for ${item.sku}: short by ${shortfall.toString()} ${item.unit}`);
      }
      // WARN policy: proceed, going negative — the caller is expected to surface a warning event.
    }

    const bookValueBefore = bookValueMinor(before);
    const { state: after, cogsMinor } = applySale(before, qty);
    const bookValueAfter = bookValueMinor(after);
    const residueMinor = bookValueAfter - (bookValueBefore - cogsMinor);

    await tx.item.update({ where: { id: itemId }, data: { qtyOnHand: after.qtyOnHand.toString(), wacMinor: after.wacMinorX1000 } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        itemId,
        movementType: 'SALE',
        qtyDelta: qtyOutD.negated().toString(),
        unitCostMinor: item.wacMinor / 1000n,
        sourceDocumentRef: sourceDocumentRef as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      },
    });

    return { residueMinor, qtyOnHand: after.qtyOnHand, wacMinorX1000: after.wacMinorX1000, cogsMinor };
  }

  async recordCreditNoteReturn(tx: TenantTx, tenantId: string, itemId: string, qty: Decimal.Value, sourceDocumentRef: unknown): Promise<StockPostingResult> {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.tracked) throw new BadRequestException(`Item ${item.sku} is not tracked for inventory`);

    const before: WacState = { qtyOnHand: item.qtyOnHand, wacMinorX1000: item.wacMinor };
    const bookValueBefore = bookValueMinor(before);
    const { state: after } = applyAdjustment(before, qty); // returning goods: qty increases, WAC unchanged
    const valueMinor = bookValueMinor(after) - bookValueBefore;
    const bookValueAfter = bookValueMinor(after);
    const residueMinor = bookValueAfter - (bookValueBefore + valueMinor);

    await tx.item.update({ where: { id: itemId }, data: { qtyOnHand: after.qtyOnHand.toString(), wacMinor: after.wacMinorX1000 } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        itemId,
        movementType: 'CREDIT_NOTE_RETURN',
        qtyDelta: new Decimal(qty).toString(),
        unitCostMinor: item.wacMinor / 1000n,
        sourceDocumentRef: sourceDocumentRef as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      },
    });

    return { residueMinor, qtyOnHand: after.qtyOnHand, wacMinorX1000: after.wacMinorX1000 };
  }

  /** Stocktake: qtyDelta is signed (negative = shrinkage). Returns the GL value delta (Dr Inventory if positive, Cr if negative) — no separate residue since this movement doesn't touch WAC. */
  async recordAdjustment(tx: TenantTx, tenantId: string, itemId: string, qtyDelta: Decimal.Value, reason: string): Promise<{ valueDeltaMinor: bigint; qtyOnHand: Decimal.Value }> {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.tracked) throw new BadRequestException(`Item ${item.sku} is not tracked for inventory`);

    const before: WacState = { qtyOnHand: item.qtyOnHand, wacMinorX1000: item.wacMinor };
    const { state: after, valueDeltaMinor } = applyAdjustment(before, qtyDelta);
    if (new Decimal(after.qtyOnHand).isNegative()) {
      throw new BadRequestException(`Adjustment would drive ${item.sku} stock negative`);
    }

    await tx.item.update({ where: { id: itemId }, data: { qtyOnHand: after.qtyOnHand.toString() } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        itemId,
        movementType: 'ADJUSTMENT',
        qtyDelta: new Decimal(qtyDelta).toString(),
        unitCostMinor: item.wacMinor / 1000n,
        sourceDocumentRef: { reason } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      },
    });

    return { valueDeltaMinor, qtyOnHand: after.qtyOnHand };
  }

  async setOpeningBalance(tx: TenantTx, tenantId: string, itemId: string, qty: Decimal.Value, unitCostMinor: bigint) {
    const item = await tx.item.findUniqueOrThrow({ where: { id: itemId } });
    if (!item.tracked) throw new BadRequestException(`Item ${item.sku} is not tracked for inventory`);
    if (new Decimal(item.qtyOnHand).greaterThan(0) || item.wacMinor > 0n) {
      throw new BadRequestException(`Item ${item.sku} already has stock — opening balance can only be set once`);
    }

    const wacMinorX1000 = unitCostMinor * 1000n;
    await tx.item.update({ where: { id: itemId }, data: { qtyOnHand: new Decimal(qty).toString(), wacMinor: wacMinorX1000 } });
    await tx.stockMovement.create({
      data: { tenantId, itemId, movementType: 'OPENING', qtyDelta: new Decimal(qty).toString(), unitCostMinor },
    });

    return { qtyOnHand: qty, wacMinorX1000, valueMinor: BigInt(new Decimal(qty).times(unitCostMinor.toString()).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)) };
  }
}
