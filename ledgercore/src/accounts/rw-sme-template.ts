import { AccountType, NormalBalance } from '@prisma/client';

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
}

const DEFAULT_NORMAL: Record<AccountType, NormalBalance> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT',
  EXPENSE: 'DEBIT',
};

function a(code: string, name: string, type: AccountType, normalBalance?: NormalBalance): SeedAccount {
  return { code, name, type, normalBalance: normalBalance ?? DEFAULT_NORMAL[type] };
}

// IFRS-for-SMEs aligned Rwanda chart of accounts (spec §6). Includes the
// MoMo clearing and RRA withholding/VAT accounts later phases depend on so
// invoicing/AP/bank-feed work never needs a schema or CoA migration.
export const RW_SME_TEMPLATE: SeedAccount[] = [
  // 1xxx Assets
  a('1000', 'Cash on Hand', 'ASSET'),
  a('1010', 'Bank – BK', 'ASSET'),
  a('1020', 'Bank – Equity', 'ASSET'),
  a('1030', 'MoMo Clearing – MTN', 'ASSET'),
  a('1040', 'MoMo Clearing – Airtel', 'ASSET'),
  a('1100', 'Accounts Receivable', 'ASSET'),
  a('1200', 'VAT Input (Receivable)', 'ASSET'),
  a('1300', 'Prepayments', 'ASSET'),
  a('1400', 'Fixed Assets', 'ASSET'),
  a('1410', 'Accumulated Depreciation', 'ASSET', 'CREDIT'), // contra-asset
  a('1450', 'Inventory', 'ASSET'),

  // 2xxx Liabilities
  a('2000', 'Accounts Payable', 'LIABILITY'),
  a('2100', 'VAT Output (18%) Payable', 'LIABILITY'),
  a('2200', 'WHT 15% Payable', 'LIABILITY'),
  a('2210', 'WHT 3% Payable (public tenders)', 'LIABILITY'),
  a('2300', 'PAYE Payable', 'LIABILITY'),
  a('2310', 'RSSB Payable', 'LIABILITY'),
  a('2400', 'Accrued Expenses', 'LIABILITY'),
  a('2500', 'Loans', 'LIABILITY'),

  // 3xxx Equity
  a('3000', 'Share Capital', 'EQUITY'),
  a('3100', 'Retained Earnings', 'EQUITY'),
  a('3200', 'Current Year Earnings', 'EQUITY'),

  // 4xxx Income
  a('4000', 'Sales Revenue', 'INCOME'),
  a('4100', 'Service Revenue', 'INCOME'),
  a('4200', 'Other Income', 'INCOME'),
  a('4300', 'FX Gain', 'INCOME'),

  // 5xxx Expenses
  a('5000', 'COGS', 'EXPENSE'),
  a('5100', 'Salaries & Wages', 'EXPENSE'),
  a('5200', 'Rent', 'EXPENSE'),
  a('5300', 'Utilities', 'EXPENSE'),
  a('5400', 'Fuel & Transport', 'EXPENSE'),
  a('5500', 'Communication & Internet', 'EXPENSE'),
  a('5600', 'Bank & MoMo Charges', 'EXPENSE'),
  a('5700', 'Depreciation', 'EXPENSE'),
  a('5800', 'Professional Fees', 'EXPENSE'),
  a('5900', 'RRA Penalties & Interest', 'EXPENSE'),
  a('5950', 'FX Loss', 'EXPENSE'),
  a('5750', 'Inventory Adjustment', 'EXPENSE'),
];
