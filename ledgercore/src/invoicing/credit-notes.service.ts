import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { TaxRatesService } from '../tax/tax-rates.service';
import { EbmService } from '../ebm/ebm.service';
import { DocumentNumberingService } from '../common/document-numbering.service';
import { ControlAccountsService } from '../common/control-accounts.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { computeLine } from '../tax/vat-calc';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';
import { CreateInvoiceLineDto } from './dto/create-invoice-line.dto';
import { CertifyReceipt } from '../ebm/ebm-adapter.interface';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffMs(attempt: number) {
  const base = Number(process.env.CERTIFY_BACKOFF_BASE_MS ?? 500);
  return base * 2 ** (attempt - 1);
}
const MAX_CERTIFY_ATTEMPTS = 5;

@Injectable()
export class CreditNotesService {
  private readonly logger = new Logger(CreditNotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly taxRates: TaxRatesService,
    private readonly ebm: EbmService,
    private readonly docNumbering: DocumentNumberingService,
    private readonly controlAccounts: ControlAccountsService,
  ) {}

  async findOne(tenantId: string, id: string) {
    const cn = await this.prisma.forTenant(tenantId, (tx) =>
      tx.creditNote.findUnique({ where: { id }, include: { lines: true } }),
    );
    if (!cn) throw new NotFoundException('Credit note not found');
    return cn;
  }

  async create(user: AuthenticatedUser, dto: CreateCreditNoteDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const original = await tx.invoice.findUnique({ where: { id: dto.originalInvoiceId } });
      if (!original) throw new NotFoundException('Original invoice not found');
      if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(original.status)) {
        throw new BadRequestException(`Cannot credit-note an invoice with status ${original.status}`);
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const computed = await this.computeLines(tx, user.tenantId, tenant.pricingMode, dto.lines);

      const alreadyCredited = await this.sumIssuedCredits(tx, dto.originalInvoiceId);
      if (alreadyCredited + computed.totalMinor > original.totalMinor) {
        throw new BadRequestException(
          `Credit note total ${computed.totalMinor} exceeds remaining creditable balance ${original.totalMinor - alreadyCredited}`,
        );
      }

      const creditNote = await tx.creditNote.create({
        data: {
          tenantId: user.tenantId,
          originalInvoiceId: dto.originalInvoiceId,
          contactId: original.contactId,
          status: 'DRAFT',
          reasonCode: dto.reasonCode,
          reasonText: dto.reasonText,
          currency: original.currency,
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
        action: 'CREDIT_NOTE_DRAFTED',
        entity: 'credit_note',
        entityId: creditNote.id,
      });

      return creditNote;
    });
  }

  async issue(user: AuthenticatedUser, id: string) {
    await this.prisma.forTenant(user.tenantId, async (tx) => {
      const creditNote = await tx.creditNote.findUnique({ where: { id }, include: { lines: { include: { item: true } } } });
      if (!creditNote) throw new NotFoundException('Credit note not found');
      if (creditNote.status === 'CERTIFY_FAILED') {
        throw new BadRequestException('Credit note certification failed previously — create a new one or contact support');
      }
      if (creditNote.status !== 'DRAFT') {
        throw new BadRequestException(`Only DRAFT credit notes can be issued (current status: ${creditNote.status})`);
      }

      // Lock the original invoice row so concurrent credit notes against it serialize.
      const originalRows = await tx.$queryRaw<{ id: string; total_minor: bigint }[]>`
        SELECT id, total_minor FROM invoices WHERE id = ${creditNote.originalInvoiceId} FOR UPDATE
      `;
      const original = await tx.invoice.findUnique({ where: { id: creditNote.originalInvoiceId }, include: { ebmReceipts: { where: { receiptType: 'NORMAL' } } } });
      if (!original || !originalRows[0]) throw new NotFoundException('Original invoice not found');
      const originalReceipt = original.ebmReceipts[0];
      if (!originalReceipt) {
        throw new BadRequestException('Original invoice has no NORMAL receipt to reference');
      }

      const alreadyCredited = await this.sumIssuedCredits(tx, creditNote.originalInvoiceId);
      if (alreadyCredited + creditNote.totalMinor > originalRows[0].total_minor) {
        throw new BadRequestException(
          `Credit note total ${creditNote.totalMinor} exceeds remaining creditable balance ${originalRows[0].total_minor - alreadyCredited}`,
        );
      }

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      for (const line of creditNote.lines) {
        if (!line.item.incomeAccountId) {
          throw new BadRequestException(`Item ${line.item.sku} has no income account configured`);
        }
      }

      const claimed = await tx.creditNote.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'CERTIFYING' } });
      if (claimed.count === 0) throw new BadRequestException('Credit note was already claimed for certification');

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'CREDIT_NOTE_CERTIFYING',
        entity: 'credit_note',
        entityId: id,
      });
    });

    setImmediate(() => {
      this.certifyCreditNote(user.tenantId, id).catch((err) => {
        this.logger.error(`certifyCreditNote(${id}) crashed: ${(err as Error).message}`);
      });
    });

    return this.prisma.forTenant(user.tenantId, (tx) => tx.creditNote.findUniqueOrThrow({ where: { id } }));
  }

  private async certifyCreditNote(tenantId: string, creditNoteId: string) {
    for (let attempt = 1; attempt <= MAX_CERTIFY_ATTEMPTS; attempt++) {
      const existingReceipt = await this.prisma.forTenant(tenantId, (tx) =>
        tx.ebmReceipt.findFirst({ where: { creditNoteId, receiptType: 'NORMAL' } }),
      );
      if (existingReceipt) {
        await this.finalizeIssued(tenantId, creditNoteId, {
          rraReceiptNo: existingReceipt.rraReceiptNo!,
          sdcId: existingReceipt.sdcId!,
          internalData: existingReceipt.internalData!,
          receiptSignature: existingReceipt.receiptSignature!,
          qrPayload: existingReceipt.qrPayload ?? '',
          vsdcDatetime: (existingReceipt.vsdcDatetime ?? new Date()).toISOString(),
        });
        return;
      }

      const creditNote = await this.prisma.forTenant(tenantId, (tx) =>
        tx.creditNote.findUnique({
          where: { id: creditNoteId },
          include: { lines: { include: { item: true } }, contact: true, originalInvoice: { include: { ebmReceipts: { where: { receiptType: 'NORMAL' } } } } },
        }),
      );
      if (!creditNote || creditNote.status !== 'CERTIFYING') return;

      const tenant = await this.prisma.forTenant(tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));

      const result = await this.prisma.forTenant(tenantId, (tx) =>
        this.ebm.certifyCreditNote(
          tx,
          tenantId,
          tenant.ebmMode,
          {
            invoiceUuid: creditNote.id,
            originalRraReceiptNo: creditNote.originalInvoice.ebmReceipts[0]?.rraReceiptNo ?? '',
            reasonCode: creditNote.reasonCode,
            reasonText: creditNote.reasonText ?? undefined,
            buyerTin: creditNote.contact.tin ?? undefined,
            buyerName: creditNote.contact.name,
            currency: creditNote.currency,
            subtotalMinor: creditNote.subtotalMinor.toString(),
            vatMinor: creditNote.vatMinor.toString(),
            totalMinor: creditNote.totalMinor.toString(),
            lines: creditNote.lines.map((l) => ({
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
        ),
      );

      if (result.outcome === 'OK' && result.data) {
        await this.finalizeIssued(tenantId, creditNoteId, result.data);
        return;
      }
      if (result.outcome === 'FATAL') {
        await this.markCertifyFailed(tenantId, creditNoteId, result.errorMessage ?? 'VSDC rejected the credit note');
        return;
      }
      if (attempt < MAX_CERTIFY_ATTEMPTS) await sleep(backoffMs(attempt));
    }
    await this.markCertifyFailed(tenantId, creditNoteId, `VSDC unreachable after ${MAX_CERTIFY_ATTEMPTS} attempts`);
  }

  private async finalizeIssued(tenantId: string, creditNoteId: string, receiptData: CertifyReceipt) {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM credit_notes WHERE id = ${creditNoteId} FOR UPDATE`;
      if (rows[0]?.status !== 'CERTIFYING') return;

      const creditNoteNo = await this.docNumbering.next(tx, tenantId, 'CREDIT_NOTE');
      const issueDate = new Date();

      const creditNote = await tx.creditNote.update({
        where: { id: creditNoteId },
        data: { status: 'ISSUED', creditNoteNo, issueDate },
        include: { lines: { include: { item: true } } },
      });

      await tx.ebmReceipt.create({
        data: {
          tenantId,
          creditNoteId,
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
      for (const line of creditNote.lines) {
        const accountId = line.item.incomeAccountId!;
        revenueByAccount.set(accountId, (revenueByAccount.get(accountId) ?? 0n) + line.lineNetMinor);
      }

      const glLines: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: bigint; currency: string }[] = [];
      for (const [accountId, amountMinor] of revenueByAccount) {
        glLines.push({ accountId, direction: 'DEBIT', amountMinor, currency: creditNote.currency });
      }
      if (creditNote.vatMinor > 0n) {
        glLines.push({ accountId: vatOutputAccountId, direction: 'DEBIT', amountMinor: creditNote.vatMinor, currency: creditNote.currency });
      }
      glLines.push({ accountId: arAccountId, direction: 'CREDIT', amountMinor: creditNote.totalMinor, currency: creditNote.currency });

      await this.journal.postSystemEntry(tx, {
        tenantId,
        entryDate: issueDate,
        memo: `Credit note ${creditNoteNo} issued`,
        sourceDocumentRef: { type: 'CREDIT_NOTE', id: creditNoteId, number: creditNoteNo.toString() },
        lines: glLines,
      });

      const totalCredited = (await this.sumIssuedCredits(tx, creditNote.originalInvoiceId));
      const original = await tx.invoice.findUniqueOrThrow({ where: { id: creditNote.originalInvoiceId } });
      if (totalCredited >= original.totalMinor) {
        await tx.invoice.update({ where: { id: original.id }, data: { status: 'CREDITED' } });
      }

      await this.audit.record(tx, {
        tenantId,
        action: 'CREDIT_NOTE_ISSUED',
        entity: 'credit_note',
        entityId: creditNoteId,
        payload: { creditNoteNo: creditNoteNo.toString(), rraReceiptNo: receiptData.rraReceiptNo },
      });
    });
  }

  private async markCertifyFailed(tenantId: string, creditNoteId: string, reason: string) {
    await this.prisma.forTenant(tenantId, async (tx) => {
      const updated = await tx.creditNote.updateMany({
        where: { id: creditNoteId, status: 'CERTIFYING' },
        data: { status: 'CERTIFY_FAILED', certifyFailReason: reason },
      });
      if (updated.count === 0) return;
      await this.audit.record(tx, {
        tenantId,
        action: 'CREDIT_NOTE_CERTIFY_FAILED',
        entity: 'credit_note',
        entityId: creditNoteId,
        payload: { reason },
      });
    });
  }

  private async sumIssuedCredits(tx: TenantTx, originalInvoiceId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ total: bigint | string | null }[]>`
      SELECT COALESCE(SUM(total_minor), 0) AS total FROM credit_notes WHERE original_invoice_id = ${originalInvoiceId} AND status = 'ISSUED'
    `;
    const total = rows[0]?.total ?? 0;
    return typeof total === 'bigint' ? total : BigInt(total.toString());
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
