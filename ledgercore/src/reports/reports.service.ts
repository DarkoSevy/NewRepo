import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { bookValueMinor } from '../inventory/wac';

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

  async arAging(tenantId: string, asOf: Date) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<
        { id: string; invoice_no: bigint | null; contact_name: string; total_minor: bigint | string; due_date: Date | null; issue_date: Date | null; paid: bigint | string; credited: bigint | string }[]
      >`
        SELECT
          i.id, i.invoice_no, c.name AS contact_name, i.total_minor, i.due_date, i.issue_date,
          COALESCE(pa.paid, 0) AS paid,
          COALESCE(cn.credited, 0) AS credited
        FROM invoices i
        JOIN contacts c ON c.id = i.contact_id
        LEFT JOIN (
          SELECT invoice_id, SUM(amount_minor) AS paid FROM payment_allocations WHERE invoice_id IS NOT NULL GROUP BY invoice_id
        ) pa ON pa.invoice_id = i.id
        LEFT JOIN (
          SELECT original_invoice_id, SUM(total_minor) AS credited FROM credit_notes WHERE status = 'ISSUED' GROUP BY original_invoice_id
        ) cn ON cn.original_invoice_id = i.id
        WHERE i.tenant_id = ${tenantId} AND i.status IN ('ISSUED', 'PARTIALLY_PAID')
      `,
    );

    return this.bucketAging(
      rows.map((row) => ({
        id: row.id,
        docNo: row.invoice_no?.toString() ?? null,
        counterparty: row.contact_name,
        openBalance: toBigInt(row.total_minor) - toBigInt(row.paid) - toBigInt(row.credited),
        dueDate: row.due_date ?? row.issue_date,
      })),
      asOf,
    );
  }

  async apAging(tenantId: string, asOf: Date) {
    const rows = await this.prisma.forTenant(tenantId, (tx) =>
      tx.$queryRaw<
        { id: string; bill_no: bigint | null; contact_name: string; total_minor: bigint | string; due_date: Date | null; bill_date: Date }[]
      >`
        SELECT
          b.id, b.bill_no, c.name AS contact_name, b.total_minor, b.due_date, b.bill_date,
          COALESCE(pa.paid, 0) AS paid
        FROM bills b
        JOIN contacts c ON c.id = b.contact_id
        LEFT JOIN (
          SELECT bill_id, SUM(amount_minor) AS paid FROM payment_allocations WHERE bill_id IS NOT NULL GROUP BY bill_id
        ) pa ON pa.bill_id = b.id
        WHERE b.tenant_id = ${tenantId} AND b.status IN ('APPROVED', 'PARTIALLY_PAID')
      `,
    );

    return this.bucketAging(
      rows.map((row: any) => ({
        // eslint-disable-line @typescript-eslint/no-explicit-any
        id: row.id,
        docNo: row.bill_no?.toString() ?? null,
        counterparty: row.contact_name,
        openBalance: toBigInt(row.total_minor) - toBigInt(row.paid ?? 0),
        dueDate: row.due_date ?? row.bill_date,
      })),
      asOf,
    );
  }

  private bucketAging(
    docs: { id: string; docNo: string | null; counterparty: string; openBalance: bigint; dueDate: Date | null }[],
    asOf: Date,
  ) {
    const buckets = { '0-30': 0n, '31-60': 0n, '61-90': 0n, '90+': 0n };
    const items = [];

    for (const doc of docs) {
      if (doc.openBalance <= 0n) continue;
      const ageDays = doc.dueDate ? Math.max(0, Math.floor((asOf.getTime() - doc.dueDate.getTime()) / 86_400_000)) : 0;
      const bucket = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+';
      buckets[bucket] += doc.openBalance;
      items.push({ id: doc.id, docNo: doc.docNo, counterparty: doc.counterparty, openBalance: doc.openBalance.toString(), ageDays, bucket });
    }

    return {
      asOf: asOf.toISOString().slice(0, 10),
      buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
      total: Object.values(buckets).reduce((a, b) => a + b, 0n).toString(),
      items,
    };
  }

  /**
   * Per-code output/input VAT from certified sales and approved bills,
   * reconciled against the actual VAT Output/Input ledger movements for the
   * same period (spec §9: "VAT return totals equal ledger movements").
   */
  async vatReturn(tenantId: string, from: Date, to: Date) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const outputRows = await tx.$queryRaw<{ tax_code: string; net: bigint | string; vat: bigint | string }[]>`
        SELECT il.tax_code, SUM(il.line_net_minor) AS net, SUM(il.line_vat_minor) AS vat
        FROM invoice_lines il
        JOIN invoices i ON i.id = il.invoice_id
        WHERE i.tenant_id = ${tenantId} AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED')
          AND i.issue_date BETWEEN ${from} AND ${to}
        GROUP BY il.tax_code
      `;
      const creditRows = await tx.$queryRaw<{ tax_code: string; net: bigint | string; vat: bigint | string }[]>`
        SELECT cnl.tax_code, SUM(cnl.line_net_minor) AS net, SUM(cnl.line_vat_minor) AS vat
        FROM credit_note_lines cnl
        JOIN credit_notes cn ON cn.id = cnl.credit_note_id
        WHERE cn.tenant_id = ${tenantId} AND cn.status = 'ISSUED' AND cn.issue_date BETWEEN ${from} AND ${to}
        GROUP BY cnl.tax_code
      `;
      const inputRows = await tx.$queryRaw<{ tax_code: string; net: bigint | string; vat: bigint | string }[]>`
        SELECT bl.tax_code, SUM(bl.line_net_minor) AS net, SUM(bl.line_vat_minor) AS vat
        FROM bill_lines bl
        JOIN bills b ON b.id = bl.bill_id
        WHERE b.tenant_id = ${tenantId} AND b.status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID')
          AND b.bill_date BETWEEN ${from} AND ${to}
        GROUP BY bl.tax_code
      `;
      // Direct expenses (ExpensesService.create) post VAT Input the same way
      // bills do but have no line/header split and no draft stage — every
      // row already hit the ledger — so they must be added here too, or
      // inputVat understates the ledger and inputMatches goes false for any
      // period containing a taxable direct expense.
      const expenseInputRows = await tx.$queryRaw<{ tax_code: string; net: bigint | string; vat: bigint | string }[]>`
        SELECT tax_code, SUM(net_minor) AS net, SUM(vat_minor) AS vat
        FROM expenses
        WHERE tenant_id = ${tenantId} AND date BETWEEN ${from} AND ${to}
        GROUP BY tax_code
      `;

      const codes = ['A', 'B', 'C', 'D'] as const;
      const output: Record<string, { net: bigint; vat: bigint }> = Object.fromEntries(codes.map((c) => [c, { net: 0n, vat: 0n }]));
      for (const row of outputRows) {
        output[row.tax_code].net += toBigInt(row.net);
        output[row.tax_code].vat += toBigInt(row.vat);
      }
      for (const row of creditRows) {
        output[row.tax_code].net -= toBigInt(row.net);
        output[row.tax_code].vat -= toBigInt(row.vat);
      }

      const input: Record<string, { net: bigint; vat: bigint }> = Object.fromEntries(codes.map((c) => [c, { net: 0n, vat: 0n }]));
      for (const row of inputRows) {
        input[row.tax_code].net += toBigInt(row.net);
        input[row.tax_code].vat += toBigInt(row.vat);
      }
      for (const row of expenseInputRows) {
        input[row.tax_code].net += toBigInt(row.net);
        input[row.tax_code].vat += toBigInt(row.vat);
      }

      const outputVatTotal = codes.reduce((sum, c) => sum + output[c].vat, 0n);
      const inputVatTotal = codes.reduce((sum, c) => sum + input[c].vat, 0n);

      const ledgerRows = await tx.$queryRaw<{ code: string; net: bigint | string }[]>`
        SELECT a.code,
          COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.direction = 'CREDIT'), 0) - COALESCE(SUM(pl.amount_minor) FILTER (WHERE pl.direction = 'DEBIT'), 0) AS net
        FROM posted_lines pl
        JOIN accounts a ON a.id = pl.account_id
        WHERE pl.tenant_id = ${tenantId} AND a.code IN ('2100', '1200') AND pl.entry_date BETWEEN ${from} AND ${to}
        GROUP BY a.code
      `;
      const ledgerOutputVat = toBigInt(ledgerRows.find((r) => r.code === '2100')?.net ?? 0);
      const ledgerInputVatCredit = toBigInt(ledgerRows.find((r) => r.code === '1200')?.net ?? 0);
      const ledgerInputVat = -ledgerInputVatCredit; // VAT Input is an asset — its ledger postings are DEBITs, so "net credit" is negative of the debit total

      return {
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        output: Object.fromEntries(codes.map((c) => [c, { net: output[c].net.toString(), vat: output[c].vat.toString() }])),
        input: Object.fromEntries(codes.map((c) => [c, { net: input[c].net.toString(), vat: input[c].vat.toString() }])),
        totals: {
          outputVat: outputVatTotal.toString(),
          inputVat: inputVatTotal.toString(),
          netVatPayable: (outputVatTotal - inputVatTotal).toString(),
        },
        reconciliation: {
          ledgerOutputVat: ledgerOutputVat.toString(),
          ledgerInputVat: ledgerInputVat.toString(),
          outputMatches: ledgerOutputVat === outputVatTotal,
          inputMatches: ledgerInputVat === inputVatTotal,
        },
      };
    });
  }

  async inventoryValuation(tenantId: string) {
    const items = await this.prisma.forTenant(tenantId, (tx) => tx.item.findMany({ where: { tracked: true }, orderBy: { sku: 'asc' } }));

    let totalValueMinor = 0n;
    const rows = items.map((item) => {
      const valueMinor = bookValueMinor({ qtyOnHand: item.qtyOnHand.toString(), wacMinorX1000: item.wacMinor });
      totalValueMinor += valueMinor;
      return {
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        qtyOnHand: item.qtyOnHand.toString(),
        wacMinorPerUnit: (item.wacMinor / 1000n).toString(),
        valueMinor: valueMinor.toString(),
      };
    });

    return { asOf: new Date().toISOString(), items: rows, totalValueMinor: totalValueMinor.toString() };
  }

  async stockMovements(tenantId: string, itemId?: string) {
    const movements = await this.prisma.forTenant(tenantId, (tx) =>
      tx.stockMovement.findMany({
        where: { itemId },
        include: { item: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return movements.map((m) => ({
      id: m.id,
      itemId: m.itemId,
      sku: m.item.sku,
      movementType: m.movementType,
      qtyDelta: m.qtyDelta.toString(),
      unitCostMinor: m.unitCostMinor.toString(),
      sourceDocumentRef: m.sourceDocumentRef,
      ebmReportedAt: m.ebmReportedAt,
      createdAt: m.createdAt,
    }));
  }
}
