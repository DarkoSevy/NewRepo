import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantTx } from '../prisma/prisma.service';
import { JournalService } from '../journal/journal.service';

interface CandidateLine {
  id: string;
  entryId: string;
  amountMinor: bigint;
  entryDate: Date;
  sourceDocumentRef: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface MatchableLine {
  id: string;
  amountMinor: bigint;
  direction: 'IN' | 'OUT';
  description: string;
  externalRef: string | null;
  lineDate: Date;
}

/**
 * The tiered auto-matcher (spec §4). Runs on statement import, stopping at
 * the first hit per line. Everything it produces lands PROPOSED — nothing
 * here ever confirms a match itself, so every CONFIRMED match still has a
 * human actor for the audit trail.
 *
 * Reconciliation only ever matches against SYSTEM journal lines already
 * posted to a financial account's own gl_account_id — in this codebase
 * that's overwhelmingly Payment-sourced entries (Phase 2 posts customer/
 * vendor payments straight to the deposit account), so the heuristic tiers
 * resolve "who is this" via `Payment.contactId` rather than trying to
 * generically unwind every possible source_document_ref type.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly journal: JournalService) {}

  async runAutoMatch(tx: TenantTx, tenantId: string, financialAccountId: string, lineIds: string[]): Promise<void> {
    const financialAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: financialAccountId } });
    const glAccountId = financialAccount.glAccountId;

    for (const lineId of lineIds) {
      const line = await tx.statementLine.findUnique({ where: { id: lineId } });
      if (!line || line.status !== 'UNMATCHED') continue;

      if (await this.tryMomoEvent(tx, tenantId, financialAccountId, glAccountId, line)) continue;
      if (await this.tryExactReference(tx, tenantId, financialAccountId, glAccountId, line)) continue;
      if (await this.tryRules(tx, tenantId, financialAccountId, glAccountId, line)) continue;
      await this.tryHeuristic(tx, tenantId, financialAccountId, glAccountId, line);
    }
  }

  private async candidateLines(tx: TenantTx, tenantId: string, glAccountId: string, line: { direction: 'IN' | 'OUT'; amountMinor: bigint }): Promise<CandidateLine[]> {
    // A statement IN (money received) is a DEBIT to an asset register;
    // OUT is a CREDIT. Bank/MoMo/cash registers are always asset accounts.
    const glDirection = line.direction === 'IN' ? 'DEBIT' : 'CREDIT';

    return tx.$queryRaw<CandidateLine[]>`
      SELECT jl.id, jl.entry_id AS "entryId", jl.amount_minor AS "amountMinor", je.entry_date AS "entryDate", je.source_document_ref AS "sourceDocumentRef"
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.tenant_id = ${tenantId}
        AND jl.account_id = ${glAccountId}
        AND jl.direction = ${glDirection}::"LineDirection"
        AND jl.amount_minor = ${line.amountMinor}
        AND je.status = 'POSTED'
        AND NOT EXISTS (SELECT 1 FROM match_legs ml WHERE ml.journal_line_id = jl.id)
    `;
  }

  private async createProposedMatch(
    tx: TenantTx,
    tenantId: string,
    financialAccountId: string,
    kind: 'MOMO_EVENT' | 'AUTO_T1' | 'RULE' | 'AUTO_T2',
    statementLineId: string,
    journalLineId: string,
  ) {
    await tx.match.create({
      data: {
        tenantId,
        financialAccountId,
        kind,
        status: 'PROPOSED',
        legs: {
          create: [{ tenantId, statementLineId }, { tenantId, journalLineId }],
        },
      },
    });
  }

  /**
   * Called from the MoMo webhook receiver right after a *new* momo_event is
   * recorded, in case a statement carrying the matching line was already
   * imported before the callback arrived — matching shouldn't depend on
   * which of the two shows up first.
   */
  async retryMomoEventMatch(tx: TenantTx, tenantId: string, momoEvent: { externalId: string | null; providerTxnId: string; amountMinor: bigint }): Promise<boolean> {
    if (!momoEvent.externalId) return false;
    const payment = await tx.payment.findUnique({ where: { id: momoEvent.externalId } });
    if (!payment) return false;

    const candidateStatementLines = await tx.statementLine.findMany({
      where: {
        tenantId,
        status: 'UNMATCHED',
        amountMinor: momoEvent.amountMinor,
        OR: [{ externalRef: momoEvent.providerTxnId }, { description: { contains: momoEvent.providerTxnId } }],
      },
    });

    for (const line of candidateStatementLines) {
      const financialAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: line.financialAccountId } });
      const candidates = await this.candidateLines(tx, tenantId, financialAccount.glAccountId, line);
      const match = candidates.find((c) => c.sourceDocumentRef?.type === 'PAYMENT' && c.sourceDocumentRef?.id === payment.id);
      if (match) {
        await this.createProposedMatch(tx, tenantId, financialAccount.id, 'MOMO_EVENT', line.id, match.id);
        return true;
      }
    }
    return false;
  }

  private async tryMomoEvent(tx: TenantTx, tenantId: string, financialAccountId: string, glAccountId: string, line: MatchableLine): Promise<boolean> {
    const events = await tx.momoEvent.findMany({ where: { tenantId, amountMinor: line.amountMinor } });
    for (const event of events) {
      if (!event.externalId) continue;
      const mentionsEvent = line.externalRef === event.providerTxnId || line.description.includes(event.providerTxnId);
      if (!mentionsEvent) continue;

      const payment = await tx.payment.findUnique({ where: { id: event.externalId } });
      if (!payment) continue;

      const candidates = await this.candidateLines(tx, tenantId, glAccountId, line);
      const match = candidates.find((c) => c.sourceDocumentRef?.type === 'PAYMENT' && c.sourceDocumentRef?.id === payment.id);
      if (match) {
        await this.createProposedMatch(tx, tenantId, financialAccountId, 'MOMO_EVENT', line.id, match.id);
        return true;
      }
    }
    return false;
  }

  private async tryExactReference(tx: TenantTx, tenantId: string, financialAccountId: string, glAccountId: string, line: MatchableLine): Promise<boolean> {
    if (!line.externalRef) return false;
    const candidates = await this.candidateLines(tx, tenantId, glAccountId, line);

    for (const candidate of candidates) {
      if (candidate.sourceDocumentRef?.type !== 'PAYMENT') continue;
      const payment = await tx.payment.findUnique({ where: { id: candidate.sourceDocumentRef.id } });
      if (payment?.reference && payment.reference === line.externalRef) {
        await this.createProposedMatch(tx, tenantId, financialAccountId, 'AUTO_T1', line.id, candidate.id);
        return true;
      }
    }
    return false;
  }

  private async tryRules(tx: TenantTx, tenantId: string, financialAccountId: string, glAccountId: string, line: MatchableLine): Promise<boolean> {
    const rules = await tx.matchRule.findMany({
      where: { tenantId, enabled: true, OR: [{ financialAccountId }, { financialAccountId: null }] },
      orderBy: { priority: 'asc' },
    });

    for (const rule of rules) {
      const predicate = rule.predicate as {
        descriptionContains?: string;
        direction?: 'IN' | 'OUT';
        amountMin?: number;
        amountMax?: number;
        refPattern?: string;
      };

      if (predicate.direction && predicate.direction !== line.direction) continue;
      if (predicate.descriptionContains && !line.description.toUpperCase().includes(predicate.descriptionContains.toUpperCase())) continue;
      if (predicate.amountMin !== undefined && line.amountMinor < BigInt(predicate.amountMin)) continue;
      if (predicate.amountMax !== undefined && line.amountMinor > BigInt(predicate.amountMax)) continue;
      if (predicate.refPattern && !new RegExp(predicate.refPattern).test(line.description)) continue;

      if (rule.action !== 'CREATE_TRANSACTION' || !rule.createSpec) continue;
      const spec = rule.createSpec as { glAccountId: string; memoTemplate?: string };

      const glDirection = line.direction === 'IN' ? 'DEBIT' : 'CREDIT';
      const otherDirection = glDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';

      const entry = await this.journal.postSystemEntry(tx, {
        tenantId,
        entryDate: line.lineDate,
        memo: spec.memoTemplate ?? `Rule-created transaction for statement line ${line.id}`,
        sourceDocumentRef: { type: 'MATCH_RULE', id: rule.id },
        lines: [
          { accountId: glAccountId, direction: glDirection, amountMinor: line.amountMinor, currency: 'RWF' },
          { accountId: spec.glAccountId, direction: otherDirection, amountMinor: line.amountMinor, currency: 'RWF' },
        ],
      });

      const ownLeg = entry.lines.find((l: { accountId: string }) => l.accountId === glAccountId);
      if (!ownLeg) throw new BadRequestException('Rule-created entry is missing its own account leg');

      await this.createProposedMatch(tx, tenantId, financialAccountId, 'RULE', line.id, ownLeg.id);
      return true;
    }
    return false;
  }

  private async tryHeuristic(tx: TenantTx, tenantId: string, financialAccountId: string, glAccountId: string, line: MatchableLine): Promise<void> {
    const candidates = await this.candidateLines(tx, tenantId, glAccountId, line);
    const from = new Date(line.lineDate.getTime() - 3 * 86_400_000);
    const to = new Date(line.lineDate.getTime() + 3 * 86_400_000);

    const scored: { candidate: CandidateLine; score: number }[] = [];
    for (const candidate of candidates) {
      if (candidate.entryDate < from || candidate.entryDate > to) continue;
      if (candidate.sourceDocumentRef?.type !== 'PAYMENT') continue;
      const payment = await tx.payment.findUnique({ where: { id: candidate.sourceDocumentRef.id } });
      if (!payment?.contactId) continue;
      const contact = await tx.contact.findUnique({ where: { id: payment.contactId } });
      if (!contact) continue;

      const rows = await tx.$queryRaw<{ score: number }[]>`SELECT similarity(${contact.name}, ${line.description}) AS score`;
      const score = rows[0]?.score ?? 0;
      if (score >= 0.4) scored.push({ candidate, score });
    }

    scored.sort((a, b) => b.score - a.score);
    for (const { candidate } of scored.slice(0, 3)) {
      await this.createProposedMatch(tx, tenantId, financialAccountId, 'AUTO_T2', line.id, candidate.id);
    }
  }
}
