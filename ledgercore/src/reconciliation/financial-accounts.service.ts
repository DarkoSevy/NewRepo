import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateFinancialAccountDto } from './dto/create-financial-account.dto';

@Injectable()
export class FinancialAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.financialAccount.findMany({ orderBy: { name: 'asc' } }));
  }

  async findOne(tenantId: string, id: string) {
    const account = await this.prisma.forTenant(tenantId, (tx) => tx.financialAccount.findUnique({ where: { id } }));
    if (!account) throw new NotFoundException('Financial account not found');
    return account;
  }

  create(user: AuthenticatedUser, dto: CreateFinancialAccountDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });
      const glAccount = await tx.account.findUnique({ where: { id: dto.glAccountId } });
      if (!glAccount) throw new NotFoundException('GL account not found');

      const existing = await tx.financialAccount.findUnique({ where: { glAccountId: dto.glAccountId } });
      if (existing) throw new BadRequestException(`GL account ${glAccount.code} already has a register (${existing.name})`);

      const account = await tx.financialAccount.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name,
          kind: dto.kind,
          glAccountId: dto.glAccountId,
          currency: tenant.baseCurrency,
          bankCode: dto.bankCode,
          accountNumberMasked: dto.accountNumberMasked,
          parserTemplate: dto.parserTemplate,
        },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'FINANCIAL_ACCOUNT_CREATED',
        entity: 'financial_account',
        entityId: account.id,
      });

      return account;
    });
  }

  async archive(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.financialAccount.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Financial account not found');
      if (existing.archivedAt) return existing;

      const archived = await tx.financialAccount.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'FINANCIAL_ACCOUNT_ARCHIVED',
        entity: 'financial_account',
        entityId: id,
      });
      return archived;
    });
  }

  async register(tenantId: string, id: string, filters: { status?: 'UNMATCHED' | 'MATCHED' | 'EXCLUDED' }) {
    const account = await this.findOne(tenantId, id);
    const lines = await this.prisma.forTenant(tenantId, (tx) =>
      tx.statementLine.findMany({
        where: { financialAccountId: id, status: filters.status },
        include: { matchLegs: { include: { match: true } } },
        orderBy: { lineDate: 'desc' },
      }),
    );
    return { account, lines };
  }

  /** Health card for a MoMo Clearing register (spec §5): balance not yet swept, and how long it's been sitting there. */
  async clearingHealth(tenantId: string, id: string, alertThresholdDays = 3) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const account = await tx.financialAccount.findUniqueOrThrow({ where: { id } });
      const glAccount = await tx.account.findUniqueOrThrow({ where: { id: account.glAccountId } });

      const rows = await tx.$queryRaw<{ debit: bigint | string; credit: bigint | string }[]>`
        SELECT
          COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) AS debit,
          COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0) AS credit
        FROM posted_lines
        WHERE account_id = ${account.glAccountId}
      `;
      const debit = toBigInt(rows[0].debit);
      const credit = toBigInt(rows[0].credit);
      const clearingBalanceMinor = glAccount.normalBalance === 'DEBIT' ? debit - credit : credit - debit;

      const recentEntries = await tx.journalEntry.findMany({
        where: { tenantId, status: 'POSTED', lines: { some: { accountId: account.glAccountId } } },
        orderBy: { entryDate: 'desc' },
        take: 20,
      });
      const lastSweepEntry = recentEntries.find((e) => (e.sourceDocumentRef as any)?.type === 'MOMO_SWEEP'); // eslint-disable-line @typescript-eslint/no-explicit-any
      const daysSinceLastSweep = lastSweepEntry ? Math.floor((Date.now() - lastSweepEntry.entryDate.getTime()) / 86_400_000) : null;

      return {
        financialAccountId: id,
        clearingBalanceMinor: clearingBalanceMinor.toString(),
        lastSweepAt: lastSweepEntry?.entryDate ?? null,
        daysSinceLastSweep,
        alertThresholdDays,
        alert: daysSinceLastSweep === null ? clearingBalanceMinor > 0n : daysSinceLastSweep > alertThresholdDays && clearingBalanceMinor > 0n,
      };
    });
  }
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}
