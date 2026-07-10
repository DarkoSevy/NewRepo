import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantTx } from '../prisma/prisma.service';

// Well-known account codes from the Phase 1 rw-sme seed template (spec §7:
// pre-provisioned exactly so later phases can post against them without a
// schema or CoA migration). If a tenant renamed/deleted one of these, GL
// posting fails loudly rather than guessing an account.
const CONTROL_ACCOUNT_CODES = {
  AR: '1100', // Accounts Receivable
  AP: '2000', // Accounts Payable
  VAT_OUTPUT: '2100', // VAT Output (18%) Payable
  VAT_INPUT: '1200', // VAT Input (Receivable)
} as const;

export type ControlAccountKey = keyof typeof CONTROL_ACCOUNT_CODES;

@Injectable()
export class ControlAccountsService {
  async resolve(tx: TenantTx, tenantId: string, key: ControlAccountKey): Promise<string> {
    const code = CONTROL_ACCOUNT_CODES[key];
    const account = await tx.account.findUnique({ where: { tenantId_code: { tenantId, code } } });
    if (!account) {
      throw new NotFoundException(
        `Control account ${key} (code ${code}) not found — run the rw-sme seed template or configure it before posting`,
      );
    }
    return account.id;
  }
}
