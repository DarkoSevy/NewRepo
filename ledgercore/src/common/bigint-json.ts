// journal_entries.entry_no and journal_lines.amount_minor are BIGINT
// (invariant #5: integer money, no floats) — Prisma maps these to JS
// BigInt, which JSON.stringify rejects by default. Money amounts stay
// exact end-to-end by serializing as decimal strings instead.
export function patchBigIntJson() {
  (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
    return this.toString();
  };
}
