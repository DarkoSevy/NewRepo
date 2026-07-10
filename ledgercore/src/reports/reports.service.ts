import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Postgres SUM(bigint) returns NUMERIC, which the driver hands back as a
// Decimal-like object/string, not a native bigint — `pg-bigint + Decimal`
// silently falls through JS's "bigint + string -> concatenation" rule
// instead of throwing, so every raw-SQL numeric aggregate must be coerced
// through here before any arithmetic touches it.
function toBigInt(value: bigint | number | string | { toString(): string }): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}

interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  normal_balance: 'DEBIT' | 'CREDIT';
  debit: bigint | string;
  credit: bigint | string;
}

interface GeneralJournalRow {
  entry_id: string;
  entry_no: bigint | null;
  entry_date: Date;
  account_code: string;
  account_name: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_minor: bigint | string;
  memo: string | null;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads through the `posted_lines` view (spec §7) rather than the raw
   * tables, so a future balance-snapshot layer can be swapped in underneath
   * without any report query changing.
   */
  async trialBalance(tenantId: string, asOf: Date) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<TrialBalanceRow[]>`
        SELECT
          a.id AS account_id,
          a.code,
          a.name,
          a.normal_balance,
          COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.direction = 'DEBIT'), 0) AS debit,
          COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.direction = 'CREDIT'), 0) AS credit
        FROM accounts a
        LEFT JOIN posted_lines pl ON pl.account_id = a.id AND pl.entry_date <= ${asOf}
        WHERE a.tenant_id = ${tenantId}
        GROUP BY a.id, a.code, a.name, a.normal_balance
        ORDER BY a.code
      `,
    );

    let totalDebits = 0n;
    let totalCredits = 0n;
    const accounts = rows.map((row) => {
      const debit = toBigInt(row.debit);
      const credit = toBigInt(row.credit);
      totalDebits += debit;
      totalCredits += credit;
      const closingBalance = row.normal_balance === 'DEBIT' ? debit - credit : credit - debit;
      return {
        accountId: row.account_id,
        code: row.code,
        name: row.name,
        normalBalance: row.normal_balance,
        debit: debit.toString(),
        credit: credit.toString(),
        closingBalance: closingBalance.toString(),
      };
    });

    return {
      asOf: asOf.toISOString().slice(0, 10),
      accounts,
      footer: { totalDebits: totalDebits.toString(), totalCredits: totalCredits.toString(), balanced: totalDebits === totalCredits },
    };
  }

  async accountLedger(tenantId: string, accountId: string, from: Date, to: Date) {
    const [account, openingRows, movementRows] = await this.prisma.forTenant(tenantId, (tx) =>
      Promise.all([
        tx.account.findUnique({ where: { id: accountId } }),
        tx.$queryRaw<{ debit: bigint | string; credit: bigint | string }[]>`
          SELECT
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0) AS debit,
            COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0) AS credit
          FROM posted_lines
          WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND entry_date < ${from}
        `,
        tx.$queryRaw<
          { entry_id: string; entry_no: bigint | null; entry_date: Date; direction: 'DEBIT' | 'CREDIT'; amount_minor: bigint | string; memo: string | null }[]
        >`
          SELECT entry_id, entry_no, entry_date, direction, amount_minor, memo
          FROM posted_lines
          WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND entry_date BETWEEN ${from} AND ${to}
          ORDER BY entry_date ASC, entry_no ASC
        `,
      ]),
    );

    const normalBalance = account?.normalBalance ?? 'DEBIT';
    const signedDelta = (direction: string, amount: bigint) => {
      const sameSideAsNormal = direction === normalBalance;
      return sameSideAsNormal ? amount : -amount;
    };

    const openingBalance =
      signedDelta('DEBIT', toBigInt(openingRows[0].debit)) + signedDelta('CREDIT', toBigInt(openingRows[0].credit));

    let runningBalance = openingBalance;
    const lines = movementRows.map((row) => {
      runningBalance += signedDelta(row.direction, toBigInt(row.amount_minor));
      return {
        entryId: row.entry_id,
        entryNo: row.entry_no?.toString() ?? null,
        entryDate: row.entry_date.toISOString().slice(0, 10),
        direction: row.direction,
        amountMinor: row.amount_minor.toString(),
        memo: row.memo,
        runningBalance: runningBalance.toString(),
      };
    });

    return {
      accountId,
      accountCode: account?.code,
      accountName: account?.name,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      openingBalance: openingBalance.toString(),
      closingBalance: runningBalance.toString(),
      lines,
    };
  }

  async generalJournal(tenantId: string, from: Date, to: Date) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<GeneralJournalRow[]>`
        SELECT
          pl.entry_id,
          pl.entry_no,
          pl.entry_date,
          a.code AS account_code,
          a.name AS account_name,
          pl.direction,
          pl.amount_minor,
          pl.memo
        FROM posted_lines pl
        JOIN accounts a ON a.id = pl.account_id
        WHERE pl.tenant_id = ${tenantId} AND pl.entry_date BETWEEN ${from} AND ${to}
        ORDER BY pl.entry_date ASC, pl.entry_no ASC, a.code ASC
      `,
    );

    return rows.map((row) => ({
      entryId: row.entry_id,
      entryNo: row.entry_no?.toString() ?? null,
      entryDate: row.entry_date.toISOString().slice(0, 10),
      accountCode: row.account_code,
      accountName: row.account_name,
      direction: row.direction,
      amountMinor: row.amount_minor.toString(),
      memo: row.memo,
    }));
  }
}
