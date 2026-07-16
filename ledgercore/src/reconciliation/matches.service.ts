import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateManualMatchDto } from './dto/create-manual-match.dto';
import { CreateAndMatchDto } from './dto/create-and-match.dto';

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
  ) {}

  async createManual(user: AuthenticatedUser, dto: CreateManualMatchDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const statementLines = await tx.statementLine.findMany({ where: { id: { in: dto.statementLineIds } } });
      if (statementLines.length !== dto.statementLineIds.length) {
        throw new NotFoundException('One or more statement lines not found');
      }
      for (const line of statementLines) {
        if (line.status !== 'UNMATCHED') throw new BadRequestException(`Statement line ${line.id} is not UNMATCHED`);
      }
      const financialAccountIds = new Set(statementLines.map((l) => l.financialAccountId));
      if (financialAccountIds.size > 1) throw new BadRequestException('All statement lines in a match must belong to the same financial account');

      const journalLines = await tx.journalLine.findMany({ where: { id: { in: dto.journalLineIds } } });
      if (journalLines.length !== dto.journalLineIds.length) {
        throw new NotFoundException('One or more journal lines not found');
      }
      const existingLegs = await tx.matchLeg.findMany({ where: { journalLineId: { in: dto.journalLineIds } } });
      if (existingLegs.length > 0) throw new BadRequestException('One or more journal lines are already matched');

      const statementTotal = statementLines.reduce((sum, l) => sum + l.amountMinor, 0n);
      const journalTotal = journalLines.reduce((sum, l) => sum + l.amountMinor, 0n);
      if (statementTotal !== journalTotal) {
        throw new BadRequestException(`Statement legs total ${statementTotal} does not equal ledger legs total ${journalTotal}`);
      }

      const financialAccountId = [...financialAccountIds][0];
      const match = await tx.match.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId,
          createdBy: user.userId,
          kind: 'MANUAL',
          status: 'PROPOSED',
          legs: {
            create: [
              ...dto.statementLineIds.map((id) => ({ tenantId: user.tenantId, statementLineId: id })),
              ...dto.journalLineIds.map((id) => ({ tenantId: user.tenantId, journalLineId: id })),
            ],
          },
        },
        include: { legs: true },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'MATCH_PROPOSED',
        entity: 'match',
        entityId: match.id,
        payload: { kind: 'MANUAL' },
      });

      return match;
    });
  }

  async confirm(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const match = await tx.match.findUnique({ where: { id }, include: { legs: true } });
      if (!match) throw new NotFoundException('Match not found');
      if (match.status !== 'PROPOSED') throw new BadRequestException(`Only PROPOSED matches can be confirmed (current: ${match.status})`);

      const statementLineIds = match.legs.filter((l) => l.statementLineId).map((l) => l.statementLineId as string);

      await tx.match.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: user.userId } });
      await tx.statementLine.updateMany({ where: { id: { in: statementLineIds } }, data: { status: 'MATCHED' } });

      // A statement line can carry several competing T2 suggestions; once
      // one is confirmed the others are moot.
      const competingMatches = await tx.match.findMany({
        where: {
          status: 'PROPOSED',
          id: { not: id },
          legs: { some: { statementLineId: { in: statementLineIds } } },
        },
      });
      for (const competing of competingMatches) {
        await tx.match.delete({ where: { id: competing.id } });
      }

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'MATCH_CONFIRMED',
        entity: 'match',
        entityId: id,
      });

      return tx.match.findUniqueOrThrow({ where: { id }, include: { legs: true } });
    });
  }

  async bulkConfirm(user: AuthenticatedUser, ids: string[]) {
    const results = [];
    for (const id of ids) {
      const match = await this.prisma.forTenant(user.tenantId, (tx) => tx.match.findUnique({ where: { id } }));
      if (!match) continue;
      if (!['MOMO_EVENT', 'AUTO_T1'].includes(match.kind)) {
        throw new BadRequestException(`Match ${id} (kind ${match.kind}) is not eligible for bulk-confirm — only MOMO_EVENT/AUTO_T1 are`);
      }
      results.push(await this.confirm(user, id));
    }
    return results;
  }

  async remove(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const match = await tx.match.findUnique({ where: { id } });
      if (!match) throw new NotFoundException('Match not found');
      if (match.status !== 'PROPOSED') throw new BadRequestException('Only PROPOSED matches can be deleted');

      await tx.match.delete({ where: { id } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'MATCH_DELETED',
        entity: 'match',
        entityId: id,
      });
      return { id, deleted: true };
    });
  }

  async excludeStatementLine(user: AuthenticatedUser, lineId: string, reason: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const line = await tx.statementLine.findUnique({ where: { id: lineId } });
      if (!line) throw new NotFoundException('Statement line not found');
      if (line.status !== 'UNMATCHED') throw new BadRequestException(`Only UNMATCHED lines can be excluded (current: ${line.status})`);

      const updated = await tx.statementLine.update({ where: { id: lineId }, data: { status: 'EXCLUDED', excludeReason: reason } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'STATEMENT_LINE_EXCLUDED',
        entity: 'statement_line',
        entityId: lineId,
        payload: { reason },
      });
      return updated;
    });
  }

  /** "Bank charge / interest" flow: create the missing GL side directly and match it in one step. */
  async createAndMatch(user: AuthenticatedUser, lineId: string, dto: CreateAndMatchDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const line = await tx.statementLine.findUnique({ where: { id: lineId } });
      if (!line) throw new NotFoundException('Statement line not found');
      if (line.status !== 'UNMATCHED') throw new BadRequestException(`Only UNMATCHED lines can be create-and-matched (current: ${line.status})`);

      const financialAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: line.financialAccountId } });
      const glDirection = line.direction === 'IN' ? 'DEBIT' : 'CREDIT';
      const otherDirection = glDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';

      const entry = await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: line.lineDate,
        memo: dto.memo ?? `Create & match: ${line.description}`,
        sourceDocumentRef: { type: 'RECONCILIATION_CREATE_AND_MATCH', id: line.id },
        lines: [
          { accountId: financialAccount.glAccountId, direction: glDirection, amountMinor: line.amountMinor, currency: financialAccount.currency },
          { accountId: dto.glAccountId, direction: otherDirection, amountMinor: line.amountMinor, currency: financialAccount.currency },
        ],
        actorId: user.userId,
      });

      const ownLeg = entry.lines.find((l: { accountId: string }) => l.accountId === financialAccount.glAccountId);
      if (!ownLeg) throw new BadRequestException('Created entry is missing its own account leg');

      const match = await tx.match.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId: line.financialAccountId,
          createdBy: user.userId,
          kind: 'MANUAL',
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          confirmedBy: user.userId,
          legs: {
            create: [
              { tenantId: user.tenantId, statementLineId: line.id },
              { tenantId: user.tenantId, journalLineId: ownLeg.id },
            ],
          },
        },
        include: { legs: true },
      });

      await tx.statementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'STATEMENT_LINE_CREATE_AND_MATCHED',
        entity: 'statement_line',
        entityId: line.id,
        payload: { matchId: match.id },
      });

      return match;
    });
  }

  /** Wallet -> bank sweep (spec §5): one SYSTEM entry, two registers, one match spanning both statement lines and both of the entry's legs. */
  async recordSweep(user: AuthenticatedUser, dto: { bankLineId: string; momoLineId: string }) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const bankLine = await tx.statementLine.findUnique({ where: { id: dto.bankLineId } });
      const momoLine = await tx.statementLine.findUnique({ where: { id: dto.momoLineId } });
      if (!bankLine || !momoLine) throw new NotFoundException('Statement line not found');
      if (bankLine.status !== 'UNMATCHED' || momoLine.status !== 'UNMATCHED') {
        throw new BadRequestException('Both lines must be UNMATCHED');
      }
      if (bankLine.direction !== 'IN' || momoLine.direction !== 'OUT') {
        throw new BadRequestException('Expected an IN line on the bank register and an OUT line on the MoMo register');
      }
      if (bankLine.amountMinor !== momoLine.amountMinor) {
        throw new BadRequestException(`Sweep amounts must match exactly (bank ${bankLine.amountMinor} vs momo ${momoLine.amountMinor})`);
      }

      const bankAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: bankLine.financialAccountId } });
      const momoAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: momoLine.financialAccountId } });

      const entry = await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: bankLine.lineDate,
        memo: 'Wallet -> bank sweep',
        sourceDocumentRef: { type: 'MOMO_SWEEP', id: momoLine.id },
        lines: [
          { accountId: bankAccount.glAccountId, direction: 'DEBIT', amountMinor: bankLine.amountMinor, currency: bankAccount.currency },
          { accountId: momoAccount.glAccountId, direction: 'CREDIT', amountMinor: momoLine.amountMinor, currency: momoAccount.currency },
        ],
        actorId: user.userId,
      });

      const bankLeg = entry.lines.find((l: { accountId: string }) => l.accountId === bankAccount.glAccountId);
      const momoLeg = entry.lines.find((l: { accountId: string }) => l.accountId === momoAccount.glAccountId);
      if (!bankLeg || !momoLeg) throw new BadRequestException('Sweep entry is missing an expected leg');

      const match = await tx.match.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId: bankAccount.id,
          createdBy: user.userId,
          kind: 'MANUAL',
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          confirmedBy: user.userId,
          legs: {
            create: [
              { tenantId: user.tenantId, statementLineId: bankLine.id },
              { tenantId: user.tenantId, journalLineId: bankLeg.id },
              { tenantId: user.tenantId, statementLineId: momoLine.id },
              { tenantId: user.tenantId, journalLineId: momoLeg.id },
            ],
          },
        },
        include: { legs: true },
      });

      await tx.statementLine.update({ where: { id: bankLine.id }, data: { status: 'MATCHED' } });
      await tx.statementLine.update({ where: { id: momoLine.id }, data: { status: 'MATCHED' } });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'MOMO_SWEEP_RECORDED',
        entity: 'match',
        entityId: match.id,
        payload: { bankLineId: bankLine.id, momoLineId: momoLine.id, amountMinor: bankLine.amountMinor.toString() },
      });

      return match;
    });
  }
}
