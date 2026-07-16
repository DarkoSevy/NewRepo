import { CsvColumnMapping } from './statement-parser.interface';

// Column names below are illustrative best-guesses at common Rwandan bank /
// MoMo portal CSV export layouts — none were validated against a real
// export file. Treat each as a starting point: download an actual
// statement, diff the header row against the mapping, and adjust before
// relying on this in production. Adding a bank is exactly this — one more
// entry here, no parser code changes.
export const CSV_TEMPLATES: Record<string, CsvColumnMapping> = {
  BK: {
    dateColumn: 'Transaction Date',
    dateFormat: 'DD/MM/YYYY',
    descriptionColumn: 'Narration',
    refColumn: 'Reference',
    debitColumn: 'Debit',
    creditColumn: 'Credit',
    balanceColumn: 'Balance',
  },
  Equity: {
    dateColumn: 'Date',
    dateFormat: 'DD/MM/YYYY',
    descriptionColumn: 'Description',
    refColumn: 'Cheque/Ref No',
    debitColumn: 'Withdrawal',
    creditColumn: 'Deposit',
    balanceColumn: 'Running Balance',
  },
  'I&M': {
    dateColumn: 'Value Date',
    dateFormat: 'DD/MM/YYYY',
    descriptionColumn: 'Particulars',
    refColumn: 'Ref No',
    debitColumn: 'Debit Amount',
    creditColumn: 'Credit Amount',
    balanceColumn: 'Balance',
  },
  Cogebanque: {
    dateColumn: 'Date',
    dateFormat: 'DD/MM/YYYY',
    descriptionColumn: 'Description',
    refColumn: 'Reference',
    debitColumn: 'Debit',
    creditColumn: 'Credit',
    balanceColumn: 'Balance',
  },
  'MoMo-MTN-portal': {
    dateColumn: 'Date',
    dateFormat: 'YYYY-MM-DD',
    descriptionColumn: 'Details',
    refColumn: 'Transaction Id',
    amountColumn: 'Amount',
    balanceColumn: 'Balance',
  },
  'MoMo-Airtel-portal': {
    dateColumn: 'Date',
    dateFormat: 'YYYY-MM-DD',
    descriptionColumn: 'Description',
    refColumn: 'Transaction ID',
    amountColumn: 'Amount',
    balanceColumn: 'Balance',
  },
};
