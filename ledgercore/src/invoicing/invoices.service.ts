import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { TaxRatesService } from '../tax/tax-rates.service';
import { EbmService } from '../ebm/ebm.service';
import { DocumentNumberingService } from '../common/document-numbering.service';
import { ControlAccountsService } from '../common/control-accounts.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { computeLine } from '../tax/vat-calc';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';
import { CreateInvoiceLineDto } from './dto/create-invoice-line.dto';
import { CertifyReceipt } from '../ebm/ebm-adapter.interface';
import { ReceiptRenderer } from './receipt-renderer';
import { StockService } from '../inventory/stock.service';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number) {
  const base = Number(process.env.CERTIFY_BACKOFF_BASE_MS ?? 500);
  return base * 2 ** (attempt - 1);
}

const MAX_CERTIFY_ATTEMPTS = 5;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly taxRates: TaxRatesService,
    private readonly ebm: EbmService,
    private readonly docNumbering: DocumentNumberingService,
    private readonly controlAccounts: ControlAccountsService,
    private readonly receiptRenderer: ReceiptRenderer,
    private readonly stock: StockService,
  ) {}

  list(tenantId: string, filters: { status?: InvoiceStatus; contactId?: string }) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.findMany({
        where: { status: filters.status, contactId: filters.contactId },
        include: { lines: true },
        orderBy: [{ createdAt: 'desc' }],
      }),
    );
  }

  async findOne(tenantId: string, id: string) {
    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id }, include: { lines: true, contact: true } }),
    );
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async create(user: AuthenticatedUser, dto: CreateInvoiceDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const contact = await tx.contact.findUnique({ where: { id: dto.contactId } });
      if (!contact) throw new NotFoundException('Contact not found');

      const computed = await this.computeLines(tx, user.tenantId, tenant.pricingMode, dto.lines);

      const invoice = await tx.invoice.create({
        data: {
          tenantId: user.tenantId,
          contactId: dto.contactId,
          kind: dto.kind ?? 'INVOICE',
          status: 'DRAFT',
          currency: tenant.baseCurrency,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          notes: dto.notes,
          sourceQuoteId: dto.sourceQuoteId,
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
        action: 'INVOICE_DRAFTED',
        entity: 'invoice',
        entityId: invoice.id,
      });

      return invoice;
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateInvoiceDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.invoice.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Invoice not found');
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException('Only DRAFT invoices can be edited');
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });

      let lineData: Awaited<ReturnType<InvoicesService['computeLines']>> | undefined;
      if (dto.lines) {
        lineData = await this.computeLines(tx, user.tenantId, tenant.pricingMode, dto.lines);
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      }

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          contactId: dto.contactId,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          notes: dto.notes,
          subtotalMinor: lineData?.subtotalMinor,
          vatMinor: lineData?.vatMinor,
          totalMinor: lineData?.totalMinor,
          lines: lineData ? { create: lineData.lines.map((l) => ({ ...l, tenantId: user.tenantId })) } : undefined,
        },
        include: { lines: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'INVOICE_UPDATED',
        entity: 'invoice',
        entityId: id,
      });

      return updated;
    });
  }

  /**
   * Validates everything we can check locally, claims the invoice
   * (DRAFT -> CERTIFYING), and returns immediately — the actual VSDC round
   * trip happens off the request/response cycle in `certifyInvoice`.
   * Production should replace the `setImmediate` dispatch with a durable
   * queue (BullMQ, etc.); the retry/idempotency logic itself doesn't change.
   */
  async issue(user: AuthenticatedUser, id: string) {
    await this.prisma.forTenant(user.tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id }, include: { lines: { include: { item: true } } } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status === 'CERTIFY_FAILED') {
        throw new BadRequestException('Invoice certification failed previously — reset to DRAFT before reissuing');
      }
      if (invoice.status !== 'DRAFT') {
        throw new BadRequestException(`Only DRAFT invoices can be issued (current status: ${invoice.status})`);
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });

      for (const line of invoice.lines) {
        if (!line.item.incomeAccountId) {
          throw new BadRequestException(`Item ${line.item.sku} has no income account configured`);
        }
        if (tenant.ebmMode === 'VSDC' && !line.item.ebmRegisteredAt) {
          throw new BadRequestException(`Item ${line.item.sku} is not registered with EBM`);
        }
        if (line.item.tracked) {
          if (!line.item.inventoryAccountId) {
            throw new BadRequestException(`Item ${line.item.sku} has no inventory account configured`);
          }
          if (tenant.negativeStockPolicy === 'BLOCK' && line.qty.greaterThan(line.item.qtyOnHand)) {
            const shortfall = line.qty.minus(line.item.qtyOnHand);
            throw new BadRequestException(`Insufficient stock for ${line.item.sku}: short by ${shortfall.toString()} ${line.item.unit}`);
          }
        }
      }

      if (tenant.ebmMode === 'VSDC') {
        const healthResult = await this.ebm.health(tx, user.tenantId, tenant.ebmMode);
        if (healthResult.outcome === 'OK' && healthResult.data?.locked) {
          throw new BadRequestException('EBM device is locked (offline for more than 24h) — cannot issue new invoices');
        }
      }

      // Preflight the exact GL preconditions finalizeIssued's postSystemEntry
      // will check — a closed period or an archived/non-postable account
      // must be caught here, before VSDC is ever called. Once certifySale
      // succeeds it is a real, irreversible external certification; catching
      // this only inside finalizeIssued would strand that certification with
      // no GL entry, and any retry would certify the same sale a second time.
      const arAccountId = await this.controlAccounts.resolve(tx, user.tenantId, 'AR');
      const glAccountIds = new Set<string>([arAccountId, ...invoice.lines.map((l) => l.item.incomeAccountId!)]);
      if (invoice.vatMinor > 0n) {
        glAccountIds.add(await this.controlAccounts.resolve(tx, user.tenantId, 'VAT_OUTPUT'));
      }
      const trackedLines = invoice.lines.filter((l) => l.item.tracked);
      if (trackedLines.length > 0) {
        glAccountIds.add(await this.controlAccounts.resolve(tx, user.tenantId, 'COGS'));
        for (const line of trackedLines) glAccountIds.add(line.item.inventoryAccountId!);
      }
      await this.journal.assertPostable(tx, user.tenantId, new Date(), [...glAccountIds]);

      const claimed = await tx.invoice.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'CERTIFYING' } });
      if (claimed.count === 0) {
        throw new BadRequestException('Invoice was already claimed for certification');
      }

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'INVOICE_CERTIFYING',
        entity: 'invoice',
        entityId: id,
      });
    });

    setImmediate(() => {
      this.certifyInvoice(user.tenantId, id).catch((err) => {
        this.logger.error(`certifyInvoice(${id}) crashed: ${(err as Error).message}`);
      });
    });

    return this.prisma.forTenant(user.tenantId, (tx) => tx.invoice.findUniqueOrThrow({ where: { id } }));
  }

  async resetToDraft(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.status !== 'CERTIFY_FAILED') {
        throw new BadRequestException(`Only CERTIFY_FAILED invoices can be reset to DRAFT (current status: ${invoice.status})`);
      }
      const updated = await tx.invoice.update({ where: { id }, data: { status: 'DRAFT', certifyFailReason: null } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'INVOICE_RESET_TO_DRAFT',
        entity: 'invoice',
        entityId: id,
      });
      return updated;
    });
  }

  /** Idempotent and safe to call concurrently/repeatedly: checks for an existing receipt before ever calling VSDC again. */
  async certifyInvoice(tenantId: string, invoiceId: string) {
    try {
      await this.runCertifyLoop(tenantId, invoiceId);
    } catch (err) {
      // Whatever went wrong — including a post-certification failure inside
      // finalizeIssued (e.g. a stock shortfall from a race with another
      // sale) — the invoice must never sit stuck in CERTIFYING forever.
      await this.markCertifyFailed(tenantId, invoiceId, (err as Error).message);
    }
  }

  private async runCertifyLoop(tenantId: string, invoiceId: string) {
    for (let attempt = 1; attempt <= MAX_CERTIFY_ATTEMPTS; attempt++) {
      const retry = await this.prisma.forTenant(tenantId, async (tx) => {
        // Serialize every concurrent certifyInvoice caller for this exact
        // invoice — the setImmediate dispatch from issue() and any future
        // manual/queue retry must never both reach VSDC for the same
        // invoice. pg_advisory_xact_lock is held for this whole attempt,
        // including the outbound VSDC call and the finalize/fail write, and
        // releases automatically at commit — a second caller blocks here
        // until the first is fully done, then observes its outcome (a
        // receipt, or status no longer CERTIFYING) and no-ops instead of
        // racing it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invoiceId})::bigint)`;

        const existingReceipt = await tx.ebmReceipt.findFirst({ where: { invoiceId, receiptType: 'NORMAL' } });
        if (existingReceipt) {
          await this.finalizeIssuedTx(tx, tenantId, invoiceId, {
            rraReceiptNo: existingReceipt.rraReceiptNo!,
            sdcId: existingReceipt.sdcId!,
            internalData: existingReceipt.internalData!,
            receiptSignature: existingReceipt.receiptSignature!,
            qrPayload: existingReceipt.qrPayload ?? '',
            vsdcDatetime: (existingReceipt.vsdcDatetime ?? new Date()).toISOString(),
          });
          return false;
        }

        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { lines: { include: { item: true } }, contact: true } });
        if (!invoice || invoice.status !== 'CERTIFYING') return false;

        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

        const result = await this.ebm.certifySale(
          tx,
          tenantId,
          tenant.ebmMode,
          {
            invoiceUuid: invoice.id,
            buyerTin: invoice.contact.tin ?? undefined,
            buyerName: invoice.contact.name,
            currency: invoice.currency,
            subtotalMinor: invoice.subtotalMinor.toString(),
            vatMinor: invoice.vatMinor.toString(),
            totalMinor: invoice.totalMinor.toString(),
            lines: invoice.lines.map((l) => ({
              rraItemCode: l.item.rraItemCode ?? l.item.sku,
              description: l.description ?? l.item.name,
              qty: l.qty.toString(),
              unitPriceMinor: l.unitPriceMinor.toString(),
              taxCode: l.taxCode,
              lineNetMinor: l.lineNetMinor.toString(),
              lineVatMinor: l.lineVatMinor.toString(),
              lineTotalMinor: l.lineTotalMinor.toString(),
            })),
          },
          attempt,
        );

        if (result.outcome === 'OK' && result.data) {
          await this.finalizeIssuedTx(tx, tenantId, invoiceId, result.data);
          return false;
        }
        if (result.outcome === 'FATAL') {
          await this.markCertifyFailedTx(tx, tenantId, invoiceId, result.errorMessage ?? 'VSDC rejected the sale');
          return false;
        }
        return true; // RETRYABLE
      });

      if (!retry) return;
      if (attempt < MAX_CERTIFY_ATTEMPTS) {
        await sleep(backoffMs(attempt));
      }
    }
    await this.markCertifyFailed(tenantId, invoiceId, `VSDC unreachable after ${MAX_CERTIFY_ATTEMPTS} attempts`);
  }

  /** Enforces spec §9: a NORMAL receipt cannot be rendered while status != ISSUED (or a later payment/credit state that implies it once was). */
  async getReceiptPdf(tenantId: string, invoiceId: string): Promise<Buffer> {
    const invoice = await this.prisma.forTenant(tenantId, (tx) =>
      tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { lines: true, contact: true, ebmReceipts: { where: { receiptType: 'NORMAL' } } },
      }),
    );
    if (!invoice) throw new NotFoundException('Invoice not found');

    const receipt = invoice.ebmReceipts[0];
    if (!receipt) {
      throw new BadRequestException(`Receipt not available while invoice is ${invoice.status} — it is only issued once certification succeeds`);
    }

    const tenant = await this.prisma.forTenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));

    return this.receiptRenderer.render({
      documentLabel: invoice.kind,
      documentNo: invoice.invoiceNo?.toString() ?? null,
      issueDate: invoice.issueDate,
      contactName: invoice.contact.name,
      contactTin: invoice.contact.tin,
      currency: invoice.currency,
      subtotalMinor: invoice.subtotalMinor,
      vatMinor: invoice.vatMinor,
      totalMinor: invoice.totalMinor,
      lines: invoice.lines.map((l) => ({
        description: l.description ?? '',
        qty: l.qty.toString(),
        unitPriceMinor: l.unitPriceMinor,
        taxCode: l.taxCode,
        lineTotalMinor: l.lineTotalMinor,
      })),
      receipt: {
        receiptType: receipt.receiptType,
        rraReceiptNo: receipt.rraReceiptNo,
        sdcId: receipt.sdcId,
        internalData: receipt.internalData,
        receiptSignature: receipt.receiptSignature,
        qrPayload: receipt.qrPayload,
      },
      isEbmDocument: tenant.ebmMode === 'VSDC',
    });
  }

  private async finalizeIssuedTx(tx: TenantTx, tenantId: string, invoiceId: string, receiptData: CertifyReceipt) {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
      if (rows[0]?.status !== 'CERTIFYING') return; // lost the race or already resolved by another attempt

      const invoiceNo = await this.docNumbering.next(tx, tenantId, 'INVOICE');
      const issueDate = new Date();

      const invoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'ISSUED', invoiceNo, issueDate },
        include: { lines: { include: { item: true } } },
      });

      await tx.ebmReceipt.create({
        data: {
          tenantId,
          invoiceId,
          receiptType: 'NORMAL',
          rraReceiptNo: receiptData.rraReceiptNo,
          sdcId: receiptData.sdcId,
          internalData: receiptData.internalData,
          receiptSignature: receiptData.receiptSignature,
          qrPayload: receiptData.qrPayload,
          vsdcDatetime: new Date(receiptData.vsdcDatetime),
          rawResponse: receiptData as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        },
      });

      const arAccountId = await this.controlAccounts.resolve(tx, tenantId, 'AR');
      const vatOutputAccountId = await this.controlAccounts.resolve(tx, tenantId, 'VAT_OUTPUT');

      const revenueByAccount = new Map<string, bigint>();
      for (const line of invoice.lines) {
        const accountId = line.item.incomeAccountId!;
        revenueByAccount.set(accountId, (revenueByAccount.get(accountId) ?? 0n) + line.lineNetMinor);
      }

      const glLines: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: bigint; currency: string }[] = [
        { accountId: arAccountId, direction: 'DEBIT', amountMinor: invoice.totalMinor, currency: invoice.currency },
      ];
      for (const [accountId, amountMinor] of revenueByAccount) {
        glLines.push({ accountId, direction: 'CREDIT', amountMinor, currency: invoice.currency });
      }
      if (invoice.vatMinor > 0n) {
        glLines.push({ accountId: vatOutputAccountId, direction: 'CREDIT', amountMinor: invoice.vatMinor, currency: invoice.currency });
      }

      // Tracked (inventory) items additionally book the COGS leg at WAC —
      // Phase 2's revenue/VAT postings above are untouched either way.
      const trackedLines = invoice.lines.filter((l) => l.item.tracked);
      if (trackedLines.length > 0) {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        const cogsAccountId = await this.controlAccounts.resolve(tx, tenantId, 'COGS');
        const residueByInventoryAccount = new Map<string, bigint>();
        let cogsTotal = 0n;

        for (const line of trackedLines) {
          if (!line.item.inventoryAccountId) throw new BadRequestException(`Item ${line.item.sku} has no inventory account configured`);
          const result = await this.stock.recordSale(tx, tenantId, line.itemId, line.qty, tenant.negativeStockPolicy, {
            type: 'INVOICE',
            id: invoiceId,
          });
          cogsTotal += result.cogsMinor;
          glLines.push({ accountId: line.item.inventoryAccountId, direction: 'CREDIT', amountMinor: result.cogsMinor, currency: invoice.currency });
          residueByInventoryAccount.set(
            line.item.inventoryAccountId,
            (residueByInventoryAccount.get(line.item.inventoryAccountId) ?? 0n) + result.residueMinor,
          );
        }
        if (cogsTotal > 0n) {
          glLines.push({ accountId: cogsAccountId, direction: 'DEBIT', amountMinor: cogsTotal, currency: invoice.currency });
        }

        const totalResidue = [...residueByInventoryAccount.values()].reduce((sum, v) => sum + v, 0n);
        if (totalResidue !== 0n) {
          const adjustmentAccountId = await this.controlAccounts.resolve(tx, tenantId, 'INVENTORY_ADJUSTMENT');
          for (const [inventoryAccountId, residue] of residueByInventoryAccount) {
            if (residue === 0n) continue;
            const amount = residue > 0n ? residue : -residue;
            if (residue > 0n) {
              glLines.push({ accountId: inventoryAccountId, direction: 'DEBIT', amountMinor: amount, currency: invoice.currency });
              glLines.push({ accountId: adjustmentAccountId, direction: 'CREDIT', amountMinor: amount, currency: invoice.currency });
            } else {
              glLines.push({ accountId: adjustmentAccountId, direction: 'DEBIT', amountMinor: amount, currency: invoice.currency });
              glLines.push({ accountId: inventoryAccountId, direction: 'CREDIT', amountMinor: amount, currency: invoice.currency });
            }
          }
        }
      }

      await this.journal.postSystemEntry(tx, {
        tenantId,
        entryDate: issueDate,
        memo: `Invoice ${invoiceNo} issued`,
        sourceDocumentRef: { type: 'INVOICE', id: invoiceId, number: invoiceNo.toString() },
        lines: glLines,
      });

      await this.audit.record(tx, {
        tenantId,
        action: 'INVOICE_ISSUED',
        entity: 'invoice',
        entityId: invoiceId,
        payload: { invoiceNo: invoiceNo.toString(), rraReceiptNo: receiptData.rraReceiptNo },
      });
  }

  private async markCertifyFailedTx(tx: TenantTx, tenantId: string, invoiceId: string, reason: string) {
      const updated = await tx.invoice.updateMany({
        where: { id: invoiceId, status: 'CERTIFYING' },
        data: { status: 'CERTIFY_FAILED', certifyFailReason: reason },
      });
      if (updated.count === 0) return;
      await this.audit.record(tx, {
        tenantId,
        action: 'INVOICE_CERTIFY_FAILED',
        entity: 'invoice',
        entityId: invoiceId,
        payload: { reason },
      });
  }

  /** Standalone wrapper for callers outside an existing transaction — the outer certifyInvoice catch-all. */
  private async markCertifyFailed(tenantId: string, invoiceId: string, reason: string) {
    await this.prisma.forTenant(tenantId, (tx) => this.markCertifyFailedTx(tx, tenantId, invoiceId, reason));
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
      if (item.archivedAt) throw new BadRequestException(`Item ${item.sku} is archived`);

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
