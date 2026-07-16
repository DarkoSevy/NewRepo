import { Injectable, BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { CsvColumnMapping, ParsedStatement, ParsedStatementLine, StatementParser } from './statement-parser.interface';

/**
 * User-mapped CSV/Excel-exported-as-CSV parser (spec §2/§3): every bank
 * "template" is just a saved `CsvColumnMapping` on top of this — adding a
 * bank means adding a mapping, not writing a new parser.
 */
@Injectable()
export class GenericCsvParser implements StatementParser {
  parse(buffer: Buffer, mapping: CsvColumnMapping): ParsedStatement {
    if (!mapping.amountColumn && !(mapping.debitColumn && mapping.creditColumn)) {
      throw new BadRequestException('Column mapping needs amountColumn, or both debitColumn and creditColumn');
    }

    let records: Record<string, string>[];
    try {
      records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      throw new BadRequestException(`Could not parse CSV: ${(err as Error).message}`);
    }

    const lines: ParsedStatementLine[] = records.map((row, i) => {
      const dateRaw = row[mapping.dateColumn];
      if (!dateRaw) throw new BadRequestException(`Row ${i + 1}: missing date column "${mapping.dateColumn}"`);
      const lineDate = parseDate(dateRaw, mapping.dateFormat);

      const description = row[mapping.descriptionColumn] ?? '';
      const externalRef = mapping.refColumn ? row[mapping.refColumn] || undefined : undefined;
      const runningBalanceMinor = mapping.balanceColumn && row[mapping.balanceColumn] ? toMinor(row[mapping.balanceColumn]) : undefined;

      let amountMinor: bigint;
      let direction: 'IN' | 'OUT';
      if (mapping.amountColumn) {
        const signed = toMinor(row[mapping.amountColumn]);
        direction = signed < 0n ? 'OUT' : 'IN';
        amountMinor = signed < 0n ? -signed : signed;
      } else {
        const debit = mapping.debitColumn && row[mapping.debitColumn] ? toMinor(row[mapping.debitColumn]) : 0n;
        const credit = mapping.creditColumn && row[mapping.creditColumn] ? toMinor(row[mapping.creditColumn]) : 0n;
        if (debit > 0n) {
          amountMinor = debit;
          direction = 'OUT';
        } else {
          amountMinor = credit;
          direction = 'IN';
        }
      }

      if (amountMinor <= 0n) {
        throw new BadRequestException(`Row ${i + 1}: could not derive a positive amount from the mapped columns`);
      }

      return { lineDate, description, externalRef, amountMinor, direction, runningBalanceMinor };
    });

    return { lines };
  }
}

function parseDate(raw: string, format = 'YYYY-MM-DD'): Date {
  if (format === 'YYYY-MM-DD') {
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`Invalid date "${raw}" for format YYYY-MM-DD`);
    return date;
  }
  if (format === 'DD/MM/YYYY') {
    const parts = raw.split('/').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) throw new BadRequestException(`Invalid date "${raw}" for format DD/MM/YYYY`);
    const [d, m, y] = parts;
    return new Date(Date.UTC(y, m - 1, d));
  }
  throw new BadRequestException(`Unsupported date format: ${format}`);
}

function toMinor(raw: string): bigint {
  const cleaned = raw.replace(/[,\s]/g, '').replace(/^\((.*)\)$/, '-$1'); // "(1,000)" accounting-negative notation
  const num = Number(cleaned);
  if (Number.isNaN(num)) throw new BadRequestException(`Invalid amount: "${raw}"`);
  return BigInt(Math.round(num));
}
