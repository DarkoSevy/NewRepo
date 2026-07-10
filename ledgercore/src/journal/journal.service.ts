import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntryStatus } from '@prisma/client';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PeriodsService } from '../periods/periods.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { UpdateJournalEntryDto } from './dto/update-journal-entry.dto';
import { CreateJournalLineDto } from './dto/create-journal-line.dto';

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly periods: PeriodsService,
  ) {}

  async findAll(tenantId: string, filters: { status?: EntryStatus; accountId?: string }) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.findMany({
        where: {
          status: filters.status,
          lines: filters.accountId ? { some: { accountId: filters.accountId } } : undefined,
        },
        include: { lines: true },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      }),
    );
  }

  async findOne(tenantId: string, id: string) {
    const entry = await this.prisma.forTenant(tenantId, (tx) =>
      tx.journalEntry.findUnique({ where: { id }, include: { lines: true } }),
    );
    if (!entry) throw new NotFoundException('Journal entry not found');
    return entry;
  }

  async create(user: AuthenticatedUser, dto: CreateJournalEntryDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      await this.validateLines(tx, user.tenantId, dto.lines);

      const entry = await tx.journalEntry.create({
        data: {
          tenantId: user.tenantId,
          entryDate: new Date(dto.entryDate),
          memo: dto.memo,
          status: 'DRAFT',
          source: 'MANUAL',
          createdBy: user.userId,
          lines: {
            create: dto.lines.map((line) => ({
              tenantId: user.tenantId,
              accountId: line.accountId,
              direction: line.direction,
              amountMinor: BigInt(line.amountMinor),
              currency: line.currency,
              memo: line.memo,
            })),
          },
        },
        include: { lines: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'JOURNAL_ENTRY_DRAFTED',
        entity: 'journal_entry',
        entityId: entry.id,
      });

      return entry;
    });
  }

  async update(user: AuthenticatedUser, entryId: string, dto: UpdateJournalEntryDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.journalEntry.findUnique({ where: { id: entryId } });
      if (!existing) throw new NotFoundException('Journal entry not found');
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException('Only DRAFT entries can be edited');
      }

      if (dto.lines) {
        await this.validateLines(tx, user.tenantId, dto.lines);
        await tx.journalLine.deleteMany({ where: { entryId } });
      }

      const updated = await tx.journalEntry.update({
        where: { id: entryId },
        data: {
          entryDate: dto.entryDate ? new Date(dto.entryDate) : undefined,
          memo: dto.memo,
          lines: dto.lines
            ? {
                create: dto.lines.map((line) => ({
                  tenantId: user.tenantId,
                  accountId: line.accountId,
                  direction: line.direction,
                  amountMinor: BigInt(line.amountMinor),
                  currency: line.currency,
                  memo: line.memo,
                })),
              }
            : undefined,
        },
        include: { lines: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'JOURNAL_ENTRY_UPDATED',
        entity: 'journal_entry',
        entityId: entryId,
      });

      return updated;
    });
  }

  async remove(user: AuthenticatedUser, entryId: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.journalEntry.findUnique({ where: { id: entryId } });
      if (!existing) throw new NotFoundException('Journal entry not found');
      if (existing.status !== 'DRAFT') {
        throw new BadRequestException('Only DRAFT entries can be deleted');
      }

      await tx.journalEntry.delete({ where: { id: entryId } });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'JOURNAL_ENTRY_DELETED',
        entity: 'journal_entry',
        entityId: entryId,
      });

      return { id: entryId, deleted: true };
    });
  }

  async post(user: AuthenticatedUser, entryId: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const entry = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
      if (!entry) throw new NotFoundException('Journal entry not found');
      if (entry.status !== 'DRAFT') {
        throw new BadRequestException(`Only DRAFT entries can be posted (current status: ${entry.status})`);
      }
      if (entry.lines.length === 0) {
        throw new BadRequestException('Cannot post an entry with no lines');
      }

      await this.assertLinesPostable(tx, entry.lines);
      this.assertBalanced(entry.lines);
      await this.periods.assertDateInOpenPeriod(tx, user.tenantId, entry.entryDate);

      const entryNo = await this.nextEntryNo(tx, user.tenantId);

      const posted = await tx.journalEntry.update({
        where: { id: entryId },
        data: { status: 'POSTED', entryNo, postedAt: new Date(), postedBy: user.userId },
        include: { lines: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'JOURNAL_ENTRY_POSTED',
        entity: 'journal_entry',
        entityId: entryId,
        payload: { entryNo: entryNo.toString() },
      });

      return posted;
    });
  }

  async reverse(user: AuthenticatedUser, entryId: string, dateOverride?: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
      if (!original) throw new NotFoundException('Journal entry not found');
      if (original.status !== 'POSTED') {
        throw new BadRequestException(`Only POSTED entries can be reversed (current status: ${original.status})`);
      }

      const reversalDate = dateOverride ? new Date(dateOverride) : new Date();
      await this.periods.assertDateInOpenPeriod(tx, user.tenantId, reversalDate);

      const entryNo = await this.nextEntryNo(tx, user.tenantId);

      const reversal = await tx.journalEntry.create({
        data: {
          tenantId: user.tenantId,
          entryNo,
          entryDate: reversalDate,
          memo: `Reversal of entry ${original.entryNo ?? original.id}`,
          status: 'POSTED',
          source: original.source,
          reversalOfId: original.id,
          postedAt: new Date(),
          postedBy: user.userId,
          createdBy: user.userId,
          lines: {
            create: original.lines.map((line) => ({
              tenantId: user.tenantId,
              accountId: line.accountId,
              direction: line.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
              amountMinor: line.amountMinor,
              currency: line.currency,
              memo: line.memo,
            })),
          },
        },
        include: { lines: true },
      });

      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: 'REVERSED' },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'JOURNAL_ENTRY_REVERSED',
        entity: 'journal_entry',
        entityId: original.id,
        payload: { reversalEntryId: reversal.id, reversalEntryNo: entryNo.toString() },
      });

      return reversal;
    });
  }

  private assertBalanced(lines: { direction: string; amountMinor: bigint }[]) {
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      if (line.direction === 'DEBIT') debit += line.amountMinor;
      else credit += line.amountMinor;
    }
    if (debit !== credit) {
      throw new BadRequestException(`Entry is not balanced: debits ${debit} != credits ${credit}`);
    }
  }

  private async assertLinesPostable(tx: TenantTx, lines: { accountId: string }[]) {
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    for (const id of accountIds) {
      const account = byId.get(id);
      if (!account) throw new BadRequestException(`Account ${id} not found`);
      if (!account.isPostable) throw new BadRequestException(`Account ${account.code} is not postable`);
      if (account.archivedAt) throw new BadRequestException(`Account ${account.code} is archived`);
    }
  }

  private async validateLines(tx: TenantTx, tenantId: string, lines: CreateJournalLineDto[]) {
    if (lines.length < 2) {
      throw new BadRequestException('An entry needs at least one debit and one credit line');
    }

    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    for (const line of lines) {
      if (line.amountMinor <= 0) {
        throw new BadRequestException('Line amounts must be positive');
      }
      if (line.currency !== tenant?.baseCurrency) {
        throw new BadRequestException(
          `Line currency ${line.currency} must match tenant base currency ${tenant?.baseCurrency}`,
        );
      }
    }

    await this.assertLinesPostable(tx, lines);
  }

  /** Assigns the next gap-free entry number for the tenant. Must run inside the posting transaction: locks the per-tenant counter row so concurrent posts serialize instead of racing. */
  private async nextEntryNo(tx: TenantTx, tenantId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ last_no: bigint }[]>`
      SELECT last_no FROM entry_no_sequences WHERE tenant_id = ${tenantId} FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new BadRequestException('Tenant has no entry-number sequence initialized');
    }
    const next = rows[0].last_no + 1n;
    await tx.$executeRaw`
      UPDATE entry_no_sequences SET last_no = ${next} WHERE tenant_id = ${tenantId}
    `;
    return next;
  }
}
