import Decimal from 'decimal.js';

function roundHalfUp(value: Decimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

export interface WacState {
  qtyOnHand: Decimal.Value;
  /** Per-unit cost in minor units, scaled ×1000 for sub-franc precision (spec §6). */
  wacMinorX1000: bigint;
}

/** wac' = (qty·wac + qty_in·unit_cost) / (qty + qty_in) */
export function applyPurchase(state: WacState, qtyIn: Decimal.Value, unitCostMinor: bigint): WacState {
  const qtyBefore = new Decimal(state.qtyOnHand);
  const qtyInD = new Decimal(qtyIn);
  const qtyAfter = qtyBefore.plus(qtyInD);

  const valueBeforeX1000 = qtyBefore.times(state.wacMinorX1000.toString());
  const valueInX1000 = qtyInD.times(unitCostMinor.toString()).times(1000);
  const newWacX1000 = qtyAfter.isZero() ? new Decimal(0) : valueBeforeX1000.plus(valueInX1000).dividedBy(qtyAfter);

  return { qtyOnHand: qtyAfter, wacMinorX1000: roundHalfUp(newWacX1000) };
}

/** COGS = qty_out · wac; WAC itself is unchanged by a sale. */
export function applySale(state: WacState, qtyOut: Decimal.Value): { state: WacState; cogsMinor: bigint } {
  const qtyBefore = new Decimal(state.qtyOnHand);
  const qtyOutD = new Decimal(qtyOut);
  const qtyAfter = qtyBefore.minus(qtyOutD);

  const cogsX1000 = qtyOutD.times(state.wacMinorX1000.toString());
  const cogsMinor = roundHalfUp(cogsX1000.dividedBy(1000));

  return { state: { qtyOnHand: qtyAfter, wacMinorX1000: state.wacMinorX1000 }, cogsMinor };
}

/** Adjustment (stocktake): same WAC, qty shifts by (possibly negative) delta. */
export function applyAdjustment(state: WacState, qtyDelta: Decimal.Value): { state: WacState; valueDeltaMinor: bigint } {
  const qtyBefore = new Decimal(state.qtyOnHand);
  const delta = new Decimal(qtyDelta);
  const qtyAfter = qtyBefore.plus(delta);
  const valueDeltaMinor = roundHalfUp(delta.times(state.wacMinorX1000.toString()).dividedBy(1000));
  return { state: { qtyOnHand: qtyAfter, wacMinorX1000: state.wacMinorX1000 }, valueDeltaMinor };
}

/** The "book value" a state represents — what GL Inventory should equal if perfectly reconciled. */
export function bookValueMinor(state: WacState): bigint {
  return roundHalfUp(new Decimal(state.qtyOnHand).times(state.wacMinorX1000.toString()).dividedBy(1000));
}
