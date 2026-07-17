import Decimal from 'decimal.js';
import { PricingMode } from '@prisma/client';

export interface LineAmounts {
  lineNetMinor: bigint;
  lineVatMinor: bigint;
  lineTotalMinor: bigint;
}

function roundHalfUp(value: Decimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/**
 * Rwanda tax codes are 0% for A/C/D and 18% for B today, but the rate is
 * never hardcoded — it's read from `tax_rates` per spec §4. Only one of
 * {net, vat, total} is ever independently rounded; the other two are
 * derived by addition/subtraction, so net + vat = total holds with zero
 * tolerance by construction, not by coincidence.
 */
export function computeLine(params: {
  pricingMode: PricingMode;
  qty: Decimal.Value;
  unitPriceMinor: bigint;
  rateBp: number;
}): LineAmounts {
  const qty = new Decimal(params.qty);
  const unitPrice = new Decimal(params.unitPriceMinor.toString());
  const rate = new Decimal(params.rateBp).dividedBy(10000);
  const gross = qty.times(unitPrice);

  if (params.pricingMode === 'TAX_INCLUSIVE') {
    const lineTotalMinor = roundHalfUp(gross);
    const lineNetMinor = roundHalfUp(new Decimal(lineTotalMinor.toString()).dividedBy(rate.plus(1)));
    const lineVatMinor = lineTotalMinor - lineNetMinor;
    return { lineNetMinor, lineVatMinor, lineTotalMinor };
  }

  const lineNetMinor = roundHalfUp(gross);
  const lineVatMinor = roundHalfUp(new Decimal(lineNetMinor.toString()).times(rate));
  const lineTotalMinor = lineNetMinor + lineVatMinor;
  return { lineNetMinor, lineVatMinor, lineTotalMinor };
}
