import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { OpenReconciliationSessionDto } from './dto/open-reconciliation-session.dto';
import { ReconciliationReportRenderer } from './reconciliation-report.renderer';

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}

@Injectable()
export class ReconciliationSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reportRenderer: ReconciliationReportRenderer,
  ) {}

  async open(user: AuthenticatedUser, financialAccountId: string, dto: OpenReconciliationSessionDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const financialAccount = await tx.financialAccount.findUnique({ where: { id: financialAccountId } });
      if (!financialAccount) throw new NotFoundException('Financial account not found');

      const session = await tx.reconciliationSession.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId,
          periodStart: new Date(dto.periodStart),
          periodEnd: new Date(dto.periodEnd),
          statementClosingBalanceMinor: BigInt(dto.statementClosingBalanceMinor),
        },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'RECONCILIATION_SESSION_OPENED',
        entity: 'reconciliation_session',
        entityId: session.id,
      });

      return session;
    });
  }

  async status(tenantId: string, id: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const session = await tx.reconciliationSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundException('Reconciliation session not found');

      const financialAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: session.financialAccountId } });
      const glClosingBalanceMinor = await this.computeGlClosingBalance(tx, financialAccount.glAccountId, session.periodEnd);
      const difference = session.statementClosingBalanceMinor - glClosingBalanceMinor;

      const unmatchedLines = await tx.statementLine.findMany({
        where: {
          financialAccountId: session.financialAccountId,
          lineDate: { gte: session.periodStart, lte: session.periodEnd },
          status: 'UNMATCHED',
        },
      });

      return {
        session,
        glClosingBalanceMinor: glClosingBalanceMinor.toString(),
        differenceMinor: difference.toString(),
        readyToComplete: difference === 0n && unmatchedLines.length === 0,
        unmatchedLines,
      };
    });
  }

  async complete(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const session = await tx.reconciliationSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundException('Reconciliation session not found');
      if (session.status !== 'OPEN') throw new BadRequestException(`Session is already ${session.status}`);

      const financialAccount = await tx.financialAccount.findUniqueOrThrow({ where: { id: session.financialAccountId } });
      const glClosingBalanceMinor = await this.computeGlClosingBalance(tx, financialAccount.glAccountId, session.periodEnd);
      const difference = session.statementClosingBalanceMinor - glClosingBalanceMinor;

      const unmatchedLines = await tx.statementLine.findMany({
        where: {
          financialAccountId: session.financialAccountId,
          lineDate: { gte: session.periodStart, lte: session.periodEnd },
          status: 'UNMATCHED',
        },
      });

      if (difference !== 0n || unmatchedLines.length > 0) {
        throw new BadRequestException({
          message: 'Cannot complete: statement and ledger are not fully reconciled',
          differenceMinor: difference.toString(),
          unmatchedLineIds: unmatchedLines.map((l) => l.id),
        });
      }

      const periodLines = await tx.statementLine.findMany({
        where: {
          financialAccountId: session.financialAccountId,
          lineDate: { gte: session.periodStart, lte: session.periodEnd },
        },
      });
      const lineIds = periodLines.map((l) => l.id);

      await tx.$executeRaw`UPDATE statement_lines SET locked_at = now() WHERE id = ANY(${lineIds})`;

      const legs = await tx.matchLeg.findMany({ where: { statementLineId: { in: lineIds } } });
      const matchIds = [...new Set(legs.map((l) => l.matchId))];
      await tx.$executeRaw`UPDATE matches SET locked_at = now() WHERE id = ANY(${matchIds})`;

      const completed = await tx.reconciliationSession.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          glClosingBalanceMinor,
          differenceMinor: 0n,
          completedAt: new Date(),
          completedBy: user.userId,
        },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'RECONCILIATION_SESSION_COMPLETED',
        entity: 'reconciliation_session',
        entityId: id,
        payload: { lockedLines: lineIds.length, lockedMatches: matchIds.length },
      });

      return completed;
    });
  }

  async reopen(user: AuthenticatedUser, id: string) {
    if (user.role !== 'OWNER') {
      throw new ForbiddenException('Only OWNER can reopen a completed reconciliation session');
    }

    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const session = await tx.reconciliationSession.findUnique({ where: { id } });
      if (!session) throw new NotFoundException('Reconciliation session not found');
      if (session.status !== 'COMPLETED') throw new BadRequestException('Session is not COMPLETED');

      const periodLines = await tx.statementLine.findMany({
        where: {
          financialAccountId: session.financialAccountId,
          lineDate: { gte: session.periodStart, lte: session.periodEnd },
        },
      });
      const lineIds = periodLines.map((l) => l.id);

      await tx.$executeRaw`UPDATE statement_lines SET locked_at = NULL WHERE id = ANY(${lineIds})`;

      const legs = await tx.matchLeg.findMany({ where: { statementLineId: { in: lineIds } } });
      const matchIds = [...new Set(legs.map((l) => l.matchId))];
      await tx.$executeRaw`UPDATE matches SET locked_at = NULL WHERE id = ANY(${matchIds})`;

      const reopened = await tx.reconciliationSession.update({
        where: { id },
        data: { status: 'OPEN', completedAt: null, completedBy: null },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'RECONCILIATION_SESSION_REOPENED',
        entity: 'reconciliation_session',
        entityId: id,
        payload: { unlockedLines: lineIds.length, unlockedMatches: matchIds.length },
      });

      return reopened;
    });
  }

  private async computeGlClosingBalance(tx: TenantTx, glAccountId: string, asOf: Date): Promise<bigint> {
    const account = await tx.account.findUniqueOrThrow({ where: { id: glAccountId } });
    const rows = await tx.$queryRaw<{ debit: bigint | string; credit: bigint | string }[]>`
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) AS debit,
        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0) AS credit
      FROM posted_lines
      WHERE account_id = ${glAccountId} AND entry_date <= ${asOf}
    `;
    const debit = toBigInt(rows[0].debit);
    const credit = toBigInt(rows[0].credit);
    return account.normalBalance === 'DEBIT' ? debit - credit : credit - debit;
  }

  async reportPdf(tenantId: string, id: string): Promise<Buffer> {
    const session = await this.prisma.forTenant(tenantId, (tx) => tx.reconciliationSession.findUnique({ where: { id } }));
    if (!session) throw new NotFoundException('Reconciliation session not found');

    const [financialAccount, counts] = await this.prisma.forTenant(tenantId, (tx) =>
      Promise.all([
        tx.financialAccount.findUniqueOrThrow({ where: { id: session.financialAccountId } }),
        Promise.all([
          tx.statementLine.count({
            where: { financialAccountId: session.financialAccountId, lineDate: { gte: session.periodStart, lte: session.periodEnd }, status: 'MATCHED' },
          }),
          tx.statementLine.count({
            where: { financialAccountId: session.financialAccountId, lineDate: { gte: session.periodStart, lte: session.periodEnd }, status: 'EXCLUDED' },
          }),
          tx.statementLine.count({
            where: { financialAccountId: session.financialAccountId, lineDate: { gte: session.periodStart, lte: session.periodEnd }, status: 'UNMATCHED' },
          }),
        ]),
      ]),
    );
    const [matchedCount, excludedCount, unmatchedCount] = counts;

    return this.reportRenderer.render({
      financialAccountName: financialAccount.name,
      periodStart: session.periodStart.toISOString().slice(0, 10),
      periodEnd: session.periodEnd.toISOString().slice(0, 10),
      statementClosingBalanceMinor: session.statementClosingBalanceMinor.toString(),
      glClosingBalanceMinor: session.glClosingBalanceMinor?.toString() ?? null,
      differenceMinor: session.differenceMinor?.toString() ?? null,
      status: session.status,
      completedAt: session.completedAt?.toISOString() ?? null,
      matchedCount,
      excludedCount,
      unmatchedCount,
    });
  }
}
