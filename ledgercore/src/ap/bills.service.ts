import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BillStatus } from '@prisma/client';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { TaxRatesService } from '../tax/tax-rates.service';
import { EbmService } from '../ebm/ebm.service';
import { DocumentNumberingService } from '../common/document-numbering.service';
import { ControlAccountsService } from '../common/control-accounts.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { computeLine } from '../tax/vat-calc';
import { CreateBillDto } from './dto/create-bill.dto';
import { CreateInvoiceLineDto } from '../invoicing/dto/create-invoice-line.dto';
import { PurchaseRecord } from '../ebm/ebm-adapter.interface';
import { StockService } from '../inventory/stock.service';

const UNCATEGORIZED_SKU = 'UNCATEGORIZED-PURCHASE';

@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly taxRates: TaxRatesService,
    private readonly ebm: EbmService,
    private readonly docNumbering: DocumentNumberingService,
    private readonly controlAccounts: ControlAccountsService,
    private readonly stock: StockService,
  ) {}

  list(tenantId: string, filters: { status?: BillStatus }) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.bill.findMany({ where: { status: filters.status }, include: { lines: true }, orderBy: { createdAt: 'desc' } }),
    );
  }

  async findOne(tenantId: string, id: string) {
    const bill = await this.prisma.forTenant(tenantId, (tx) => tx.bill.findUnique({ where: { id }, include: { lines: true } }));
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  async create(user: AuthenticatedUser, dto: CreateBillDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const contact = await tx.contact.findUnique({ where: { id: dto.contactId } });
      if (!contact) throw new NotFoundException('Contact not found');

      const computed = await this.computeLines(tx, user.tenantId, tenant.pricingMode, dto.lines);

      const bill = await tx.bill.create({
        data: {
          tenantId: user.tenantId,
          contactId: dto.contactId,
          origin: 'MANUAL',
          status: 'DRAFT',
          billDate: new Date(dto.billDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          currency: tenant.baseCurrency,
          notes: dto.notes,
          subtotalMinor: computed.subtotalMinor,
          vatMinor: computed.vatMinor,
          totalMinor: computed.totalMinor,
          createdBy: user.userId,
          lines: { create: computed.lines.map((l) => ({ ...l, tenantId: user.tenantId })) },
        },
        include: { lines: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'BILL_DRAFTED',
        entity: 'bill',
        entityId: bill.id,
      });

      return bill;
    });
  }

  async approve(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const bill = await tx.bill.findUnique({ where: { id }, include: { lines: { include: { item: true } } } });
      if (!bill) throw new NotFoundException('Bill not found');
      if (bill.status !== 'DRAFT') {
        throw new BadRequestException(`Only DRAFT bills can be approved (current status: ${bill.status})`);
      }

      for (const line of bill.lines) {
        if (!line.item.expenseAccountId) {
          throw new BadRequestException(`Item ${line.item.sku} has no expense account configured`);
        }
      }

      const billNo = await this.docNumbering.next(tx, user.tenantId, 'BILL');
      const approved = await tx.bill.update({
        where: { id },
        data: { status: 'APPROVED', billNo, approvedAt: new Date(), approvedBy: user.userId },
        include: { lines: { include: { item: true } } },
      });

      const apAccountId = await this.controlAccounts.resolve(tx, user.tenantId, 'AP');
      const vatInputAccountId = await this.controlAccounts.resolve(tx, user.tenantId, 'VAT_INPUT');

      // Tracked (inventory) items post to Inventory instead of an expense
      // account, and update WAC — everything else is untouched from Phase 2.
      // Each item's WAC-rounding residue settles against its OWN inventory
      // account, never against AP (AP reflects the bill's exact total,
      // which is real money owed and has nothing to do with WAC rounding).
      const expenseByAccount = new Map<string, bigint>();
      const residueByInventoryAccount = new Map<string, bigint>();
      for (const line of approved.lines) {
        if (line.item.tracked) {
          if (!line.item.inventoryAccountId) throw new BadRequestException(`Item ${line.item.sku} has no inventory account configured`);
          const result = await this.stock.recordPurchase(tx, user.tenantId, line.itemId, line.qty, line.unitPriceMinor, { type: 'BILL', id });
          expenseByAccount.set(line.item.inventoryAccountId, (expenseByAccount.get(line.item.inventoryAccountId) ?? 0n) + line.lineNetMinor);
          residueByInventoryAccount.set(
            line.item.inventoryAccountId,
            (residueByInventoryAccount.get(line.item.inventoryAccountId) ?? 0n) + result.residueMinor,
          );
        } else {
          const accountId = line.item.expenseAccountId!;
          expenseByAccount.set(accountId, (expenseByAccount.get(accountId) ?? 0n) + line.lineNetMinor);
        }
      }

      const glLines: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: bigint; currency: string }[] = [];
      for (const [accountId, amountMinor] of expenseByAccount) {
        glLines.push({ accountId, direction: 'DEBIT', amountMinor, currency: approved.currency });
      }
      if (approved.vatMinor > 0n) {
        glLines.push({ accountId: vatInputAccountId, direction: 'DEBIT', amountMinor: approved.vatMinor, currency: approved.currency });
      }
      glLines.push({ accountId: apAccountId, direction: 'CREDIT', amountMinor: approved.totalMinor, currency: approved.currency });

      const totalResidue = [...residueByInventoryAccount.values()].reduce((sum, v) => sum + v, 0n);
      if (totalResidue !== 0n) {
        const adjustmentAccountId = await this.controlAccounts.resolve(tx, user.tenantId, 'INVENTORY_ADJUSTMENT');
        for (const [inventoryAccountId, residue] of residueByInventoryAccount) {
          if (residue === 0n) continue;
          const amount = residue > 0n ? residue : -residue;
          if (residue > 0n) {
            glLines.push({ accountId: inventoryAccountId, direction: 'DEBIT', amountMinor: amount, currency: approved.currency });
            glLines.push({ accountId: adjustmentAccountId, direction: 'CREDIT', amountMinor: amount, currency: approved.currency });
          } else {
            glLines.push({ accountId: adjustmentAccountId, direction: 'DEBIT', amountMinor: amount, currency: approved.currency });
            glLines.push({ accountId: inventoryAccountId, direction: 'CREDIT', amountMinor: amount, currency: approved.currency });
          }
        }
      }

      await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: approved.billDate,
        memo: `Bill ${billNo} approved`,
        sourceDocumentRef: { type: 'BILL', id, number: billNo.toString() },
        lines: glLines,
        actorId: user.userId,
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'BILL_APPROVED',
        entity: 'bill',
        entityId: id,
        payload: { billNo: billNo.toString() },
      });

      return approved;
    });
  }

  /** EBM purchase sync (spec §7 `POST /ebm/sync-purchases`): pulls supplier-certified purchases and creates DRAFT bills, deduped on (tenant, supplier TIN, receipt no). Lines land against a placeholder item pending accountant reclassification since VSDC purchase records don't carry our internal item catalog IDs. */
  async syncFromEbm(user: AuthenticatedUser) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const result = await this.ebm.syncPurchases(tx, user.tenantId, tenant.ebmMode);
      if (result.outcome !== 'OK' || !result.data) {
        throw new BadRequestException(result.errorMessage ?? 'EBM purchase sync failed');
      }

      const placeholderItem = await this.getOrCreatePlaceholderItem(tx, user.tenantId);
      const created: string[] = [];

      for (const purchase of result.data) {
        const existing = await tx.bill.findFirst({
          where: { tenantId: user.tenantId, supplierTin: purchase.supplierTin, supplierReceiptNo: purchase.supplierReceiptNo },
        });
        if (existing) continue;

        const contact = await this.getOrCreateVendorContact(tx, user.tenantId, purchase);

        const bill = await tx.bill.create({
          data: {
            tenantId: user.tenantId,
            contactId: contact.id,
            origin: 'EBM_SYNC',
            status: 'DRAFT',
            billDate: new Date(purchase.purchaseDate),
            currency: purchase.currency,
            supplierReceiptNo: purchase.supplierReceiptNo,
            supplierTin: purchase.supplierTin,
            subtotalMinor: BigInt(purchase.subtotalMinor),
            vatMinor: BigInt(purchase.vatMinor),
            totalMinor: BigInt(purchase.totalMinor),
            lines: {
              create: purchase.lines.map((l) => ({
                tenantId: user.tenantId,
                itemId: placeholderItem.id,
                description: l.description,
                qty: l.qty,
                unitPriceMinor: BigInt(l.unitPriceMinor),
                taxCode: l.taxCode,
                lineNetMinor: BigInt(l.lineNetMinor),
                lineVatMinor: BigInt(l.lineVatMinor),
                lineTotalMinor: BigInt(l.lineTotalMinor),
              })),
            },
          },
        });
        created.push(bill.id);
      }

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'EBM_PURCHASES_SYNCED',
        entity: 'bill',
        payload: { created: created.length },
      });

      return { created: created.length, skipped: result.data.length - created.length };
    });
  }

  private async getOrCreatePlaceholderItem(tx: TenantTx, tenantId: string) {
    const existing = await tx.item.findUnique({ where: { tenantId_sku: { tenantId, sku: UNCATEGORIZED_SKU } } });
    if (existing) return existing;

    const expenseAccount = await tx.account.findUnique({ where: { tenantId_code: { tenantId, code: '2400' } } }); // Accrued Expenses
    return tx.item.create({
      data: {
        tenantId,
        sku: UNCATEGORIZED_SKU,
        name: 'Uncategorized EBM purchase (reclassify before approving)',
        type: 'SERVICE',
        taxCode: 'B',
        unit: 'unit',
        defaultPriceMinor: 0n,
        expenseAccountId: expenseAccount?.id,
      },
    });
  }

  private async getOrCreateVendorContact(tx: TenantTx, tenantId: string, purchase: PurchaseRecord) {
    const existing = await tx.contact.findFirst({ where: { tenantId, tin: purchase.supplierTin } });
    if (existing) return existing;
    return tx.contact.create({
      data: { tenantId, kind: 'VENDOR', name: purchase.supplierName, tin: purchase.supplierTin },
    });
  }

  private async computeLines(
    tx: TenantTx,
    tenantId: string,
    pricingMode: 'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE',
    lines: CreateInvoiceLineDto[],
  ) {
    let subtotalMinor = 0n;
    let vatMinor = 0n;
    let totalMinor = 0n;
    const today = new Date();
    const results = [];

    for (const line of lines) {
      const item = await tx.item.findUnique({ where: { id: line.itemId } });
      if (!item) throw new NotFoundException(`Item ${line.itemId} not found`);

      const unitPriceMinor = line.unitPriceMinor !== undefined ? BigInt(line.unitPriceMinor) : item.defaultPriceMinor;
      const rateBp = await this.taxRates.getRateBp(tx, tenantId, item.taxCode, today);
      const amounts = computeLine({ pricingMode, qty: line.qty, unitPriceMinor, rateBp });

      subtotalMinor += amounts.lineNetMinor;
      vatMinor += amounts.lineVatMinor;
      totalMinor += amounts.lineTotalMinor;

      results.push({
        itemId: item.id,
        description: line.description,
        qty: line.qty,
        unitPriceMinor,
        taxCode: item.taxCode,
        lineNetMinor: amounts.lineNetMinor,
        lineVatMinor: amounts.lineVatMinor,
        lineTotalMinor: amounts.lineTotalMinor,
      });
    }

    return { lines: results, subtotalMinor, vatMinor, totalMinor };
  }
}
