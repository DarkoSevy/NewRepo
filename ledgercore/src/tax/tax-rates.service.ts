import { Injectable, NotFoundException } from '@nestjs/common';
import { TaxCode } from '@prisma/client';
import { TenantTx } from '../prisma/prisma.service';

// Rwanda EBM tax-code mapping (spec §4). Rates still live in `tax_rates` per
// tenant — this is only the seed applied once at tenant creation.
const DEFAULT_RATES_BP: Record<TaxCode, number> = {
  A: 0, // exempt
  B: 1800, // standard 18%
  C: 0, // export / zero-rated
  D: 0, // non-taxable
};

@Injectable()
export class TaxRatesService {
  async seedDefaults(tx: TenantTx, tenantId: string, validFrom: Date) {
    await tx.taxRate.createMany({
      data: (Object.keys(DEFAULT_RATES_BP) as TaxCode[]).map((code) => ({
        tenantId,
        code,
        rateBp: DEFAULT_RATES_BP[code],
        validFrom,
      })),
    });
  }

  /** Effective rate for `code` as of `date` — the most recent `validFrom` on or before it. */
  async getRateBp(tx: TenantTx, tenantId: string, code: TaxCode, date: Date): Promise<number> {
    const rate = await tx.taxRate.findFirst({
      where: { tenantId, code, validFrom: { lte: date } },
      orderBy: { validFrom: 'desc' },
    });
    if (!rate) {
      throw new NotFoundException(`No tax_rates entry for code ${code} effective on or before ${date.toISOString().slice(0, 10)}`);
    }
    return rate.rateBp;
  }
}
