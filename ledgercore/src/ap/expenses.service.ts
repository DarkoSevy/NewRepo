import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { TaxRatesService } from '../tax/tax-rates.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { computeLine } from '../tax/vat-calc';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly taxRates: TaxRatesService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.expense.findMany({ orderBy: { date: 'desc' } }));
  }

  async findOne(tenantId: string, id: string) {
    const expense = await this.prisma.forTenant(tenantId, (tx) => tx.expense.findUnique({ where: { id } }));
    if (!expense) throw new NotFoundException('Expense not found');
    return expense;
  }

  /** No draft stage — a direct expense posts to the GL immediately on creation. */
  async create(user: AuthenticatedUser, dto: CreateExpenseDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const date = new Date(dto.date);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const rateBp = await this.taxRates.getRateBp(tx, user.tenantId, dto.taxCode, date);
      // Expense receipts are always entered as a gross total, regardless of the tenant's invoicing pricing mode.
      const amounts = computeLine({ pricingMode: 'TAX_INCLUSIVE', qty: 1, unitPriceMinor: BigInt(dto.amountMinor), rateBp });

      const expense = await tx.expense.create({
        data: {
          tenantId: user.tenantId,
          contactId: dto.contactId,
          expenseAccountId: dto.expenseAccountId,
          paidFromAccountId: dto.paidFromAccountId,
          taxCode: dto.taxCode,
          date,
          amountMinor: amounts.lineTotalMinor,
          netMinor: amounts.lineNetMinor,
          vatMinor: amounts.lineVatMinor,
          memo: dto.memo,
          receiptAttachmentRef: dto.receiptAttachmentRef,
          createdBy: user.userId,
        },
      });

      const vatAccountId =
        amounts.lineVatMinor > 0n
          ? (await tx.account.findUnique({ where: { tenantId_code: { tenantId: user.tenantId, code: '1200' } } }))?.id
          : undefined;

      const glLines: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: bigint; currency: string }[] = [
        { accountId: dto.expenseAccountId, direction: 'DEBIT', amountMinor: amounts.lineNetMinor, currency: tenant.baseCurrency },
      ];
      if (amounts.lineVatMinor > 0n && vatAccountId) {
        glLines.push({ accountId: vatAccountId, direction: 'DEBIT', amountMinor: amounts.lineVatMinor, currency: tenant.baseCurrency });
      }
      glLines.push({ accountId: dto.paidFromAccountId, direction: 'CREDIT', amountMinor: amounts.lineTotalMinor, currency: tenant.baseCurrency });

      await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: date,
        memo: dto.memo ?? 'Direct expense',
        sourceDocumentRef: { type: 'EXPENSE', id: expense.id },
        lines: glLines,
        actorId: user.userId,
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'EXPENSE_RECORDED',
        entity: 'expense',
        entityId: expense.id,
      });

      return expense;
    });
  }
}
