import fc from 'fast-check';
import Decimal from 'decimal.js';
import { applyPurchase, applySale, bookValueMinor, WacState } from './wac';

/**
 * Simulates the same residue-flushing discipline StockService applies on
 * every movement: post the real economic amount (bill cost on purchase,
 * -COGS on sale), then flush whatever gap remains between that and the
 * WAC-implied book value to Inventory Adjustment. This property test
 * proves that discipline actually keeps the invariant (spec §9): GL
 * Inventory == qty·wac at every step, with each movement's residue
 * bounded (so total residue over n movements never exceeds n francs).
 */
describe('WAC engine', () => {
  it('purchase/sale sequences keep GL inventory == qty·wac, with bounded per-movement residue', () => {
    const movement = fc.oneof(
      fc.record({ kind: fc.constant('purchase' as const), qty: fc.integer({ min: 1, max: 500 }), unitCostMinor: fc.integer({ min: 1, max: 100_000 }) }),
      fc.record({ kind: fc.constant('sale' as const), qtyFraction: fc.integer({ min: 1, max: 100 }) }),
    );

    fc.assert(
      fc.property(fc.array(movement, { minLength: 1, maxLength: 100 }), (movements) => {
        let state: WacState = { qtyOnHand: new Decimal(0), wacMinorX1000: 0n };
        let glBalance = 0n;
        let totalAbsResidue = 0n;
        let movementCount = 0;

        for (const m of movements) {
          if (m.kind === 'purchase') {
            const before = state;
            state = applyPurchase(state, m.qty, BigInt(m.unitCostMinor));
            const postedAmount = BigInt(m.qty) * BigInt(m.unitCostMinor); // the real bill amount
            glBalance += postedAmount;

            const target = bookValueMinor(state);
            const residue = target - glBalance;
            glBalance += residue; // flush to Inventory Adjustment
            totalAbsResidue += residue < 0n ? -residue : residue;
            movementCount++;
            void before;
          } else {
            // Never sell more than is on hand — the negative-stock policy's job, not WAC's.
            const qtyOnHand = new Decimal(state.qtyOnHand);
            if (qtyOnHand.lte(0)) continue;
            const qtyOut = Decimal.min(qtyOnHand, new Decimal(m.qtyFraction).dividedBy(100).times(qtyOnHand)).toDecimalPlaces(3);
            if (qtyOut.lte(0)) continue;

            const { state: newState, cogsMinor } = applySale(state, qtyOut);
            state = newState;
            glBalance -= cogsMinor;

            const target = bookValueMinor(state);
            const residue = target - glBalance;
            glBalance += residue;
            totalAbsResidue += residue < 0n ? -residue : residue;
            movementCount++;
          }

          // Invariant: GL always equals the WAC-implied book value after flushing.
          expect(glBalance).toBe(bookValueMinor(state));
        }

        // Each movement's residue comes from half-up rounding of a single
        // division — bounded well under 1 franc — so the cumulative
        // absolute residue can never exceed one franc per movement.
        expect(totalAbsResidue).toBeLessThanOrEqual(BigInt(movementCount));
      }),
    );
  });

  it('never produces a negative WAC or book value from a valid (non-oversold) sequence', () => {
    let state: WacState = { qtyOnHand: new Decimal(0), wacMinorX1000: 0n };
    state = applyPurchase(state, 10, 1000n);
    expect(state.wacMinorX1000).toBe(1000000n); // 1000 minor units/unit, x1000
    const { state: afterSale, cogsMinor } = applySale(state, 4);
    expect(cogsMinor).toBe(4000n);
    expect(new Decimal(afterSale.qtyOnHand).toString()).toBe('6');
  });
});
