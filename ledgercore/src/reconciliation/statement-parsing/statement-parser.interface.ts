export interface ParsedStatementLine {
  lineDate: Date;
  description: string;
  externalRef?: string;
  amountMinor: bigint;
  direction: 'IN' | 'OUT';
  runningBalanceMinor?: bigint;
}

export interface ParsedStatement {
  lines: ParsedStatementLine[];
}

export interface CsvColumnMapping {
  dateColumn: string;
  /** 'YYYY-MM-DD' (default) or 'DD/MM/YYYY' */
  dateFormat?: string;
  descriptionColumn: string;
  refColumn?: string;
  balanceColumn?: string;
  /** A single signed amount column, OR debitColumn+creditColumn — pick one style. */
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
}

export interface StatementParser {
  parse(buffer: Buffer, mapping: CsvColumnMapping): ParsedStatement;
}
