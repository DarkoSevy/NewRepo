import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { MomoProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MatchingService } from './matching.service';

interface MomoWebhookPayload {
  externalId?: string;
  providerTxnId: string;
  status: string;
  amountMinor: number;
  msisdn?: string;
}

/**
 * Receives MoMo callbacks for payments we initiated. Field names/shapes are
 * illustrative — MTN/Airtel's actual webhook contract wasn't available
 * while building this — but the structural pieces (HMAC verification, IP
 * allowlist, append-only idempotent event log, retroactive T0 matching)
 * are real and match spec §2/§4/§9.
 *
 * externalId is expected as `${tenantId}.${paymentId}` — there is no tenant
 * context on an inbound webhook otherwise, and RLS has nothing to scope by
 * until we know which tenant this callback belongs to.
 */
@Injectable()
export class MomoWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
  ) {}

  verifySignature(provider: MomoProvider, rawBody: Buffer, signatureHeader: string | undefined) {
    const secret = process.env[`MOMO_${provider}_WEBHOOK_SECRET`];
    if (!secret) return; // no secret configured — dev/test only, never true in production
    if (!signatureHeader) throw new ForbiddenException('Missing webhook signature');

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const givenBuf = Buffer.from(signatureHeader, 'hex');
    if (expectedBuf.length !== givenBuf.length || !timingSafeEqual(expectedBuf, givenBuf)) {
      throw new ForbiddenException('Invalid webhook signature');
    }
  }

  verifyIpAllowlist(sourceIp: string | undefined) {
    const allowlist = (process.env.MOMO_WEBHOOK_IP_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowlist.length === 0) return; // unset — dev/test only
    if (!sourceIp || !allowlist.includes(sourceIp)) {
      throw new ForbiddenException('Source IP not allowlisted for MoMo webhooks');
    }
  }

  async receive(provider: MomoProvider, rawBody: Buffer, signatureHeader: string | undefined, sourceIp: string | undefined) {
    this.verifySignature(provider, rawBody, signatureHeader);
    this.verifyIpAllowlist(sourceIp);

    let payload: MomoWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }
    if (!payload.providerTxnId || payload.amountMinor === undefined) {
      throw new BadRequestException('providerTxnId and amountMinor are required');
    }

    // externalId arrives as `${tenantId}.${paymentId}`; only the payment
    // UUID is stored (momo_events.external_id is "our payment UUID" per
    // spec §3) so the matcher can look the payment up by id directly.
    const dotAt = payload.externalId?.indexOf('.') ?? -1;
    if (!payload.externalId || dotAt <= 0 || dotAt === payload.externalId.length - 1) {
      throw new BadRequestException('externalId must be "<tenantId>.<paymentId>"');
    }
    const tenantId = payload.externalId.slice(0, dotAt);
    const paymentId = payload.externalId.slice(dotAt + 1);

    const uniqueKey = { tenantId_provider_providerTxnId: { tenantId, provider, providerTxnId: payload.providerTxnId } };

    try {
      return await this.prisma.forTenant(tenantId, async (tx) => {
        // Check-first for the common replay path. The P2002 catch below can't
        // live inside this transaction: a failed INSERT aborts the Postgres
        // transaction, so any fallback query in it would fail too.
        const existing = await tx.momoEvent.findUnique({ where: uniqueKey });
        if (existing) return { deduped: true, momoEventId: existing.id };

        const event = await tx.momoEvent.create({
          data: {
            tenantId,
            provider,
            externalId: paymentId,
            providerTxnId: payload.providerTxnId,
            status: payload.status,
            amountMinor: BigInt(payload.amountMinor),
            msisdnMasked: maskMsisdn(payload.msisdn),
            raw: payload as unknown as Prisma.InputJsonValue,
          },
        });

        await this.matching.retryMomoEventMatch(tx, tenantId, event);
        return { deduped: false, momoEventId: event.id };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Two concurrent first deliveries raced past the check — the loser's
        // transaction rolled back; report the winner's event in a fresh one.
        const existing = await this.prisma.forTenant(tenantId, (tx) => tx.momoEvent.findUniqueOrThrow({ where: uniqueKey }));
        return { deduped: true, momoEventId: existing.id };
      }
      throw err;
    }
  }
}

function maskMsisdn(msisdn?: string): string | undefined {
  if (!msisdn) return undefined;
  return msisdn.length <= 4 ? msisdn : `${'*'.repeat(msisdn.length - 4)}${msisdn.slice(-4)}`;
}
