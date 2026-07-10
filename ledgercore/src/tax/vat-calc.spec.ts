import fc from 'fast-check';
import { computeLine } from './vat-calc';

describe('computeLine (VAT engine)', () => {
  it('TAX_EXCLUSIVE: net + vat = total for arbitrary amounts at 18%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), fc.integer({ min: 1, max: 1000 }), (unitPriceMinor, qtyThousandths) => {
        const qty = qtyThousandths / 1000;
        const { lineNetMinor, lineVatMinor, lineTotalMinor } = computeLine({
          pricingMode: 'TAX_EXCLUSIVE',
          qty,
          unitPriceMinor: BigInt(unitPriceMinor),
          rateBp: 1800,
        });
        expect(lineNetMinor + lineVatMinor).toBe(lineTotalMinor);
      }),
    );
  });

  it('TAX_INCLUSIVE: net + vat = total for arbitrary gross amounts 1..10^9 at 18%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (grossMinor) => {
        const { lineNetMinor, lineVatMinor, lineTotalMinor } = computeLine({
          pricingMode: 'TAX_INCLUSIVE',
          qty: 1,
          unitPriceMinor: BigInt(grossMinor),
          rateBp: 1800,
        });
        expect(lineNetMinor + lineVatMinor).toBe(lineTotalMinor);
        expect(lineTotalMinor).toBe(BigInt(grossMinor));
        expect(lineNetMinor).toBeGreaterThanOrEqual(0n);
        expect(lineVatMinor).toBeGreaterThanOrEqual(0n);
      }),
    );
  });

  it('zero-rated codes (0bp) produce zero VAT with net = total', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (amount) => {
        const excl = computeLine({ pricingMode: 'TAX_EXCLUSIVE', qty: 1, unitPriceMinor: BigInt(amount), rateBp: 0 });
        expect(excl.lineVatMinor).toBe(0n);
        expect(excl.lineNetMinor).toBe(excl.lineTotalMinor);

        const incl = computeLine({ pricingMode: 'TAX_INCLUSIVE', qty: 1, unitPriceMinor: BigInt(amount), rateBp: 0 });
        expect(incl.lineVatMinor).toBe(0n);
        expect(incl.lineNetMinor).toBe(incl.lineTotalMinor);
      }),
    );
  });
});
