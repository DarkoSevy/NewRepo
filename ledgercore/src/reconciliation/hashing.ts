import { createHash } from 'crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Dedupe key for a statement line: same account + date + amount + direction + ref + description hashes identically whether it arrives via this file or an overlapping one. */
export function statementLineHash(params: {
  financialAccountId: string;
  lineDate: Date;
  amountMinor: bigint;
  direction: string;
  externalRef?: string;
  description: string;
}): string {
  const key = [
    params.financialAccountId,
    params.lineDate.toISOString().slice(0, 10),
    params.amountMinor.toString(),
    params.direction,
    params.externalRef ?? '',
    params.description,
  ].join('|');
  return sha256Hex(key);
}
