import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type TenantTx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: {
        db: {
          url: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs `fn` inside a single transaction with Postgres RLS's
   * `app.tenant_id` set for that transaction only (SET LOCAL semantics via
   * set_config(..., true)). Every tenant-scoped read/write must go through
   * this so RLS is always the enforced second wall, not an opt-in.
   *
   * The balance/immutability triggers are DEFERRABLE INITIALLY DEFERRED so
   * they only run once per transaction, at commit — but Prisma's engine
   * does not reliably surface a Postgres error raised during its own
   * implicit COMMIT as a rejected promise. Forcing the check with an
   * explicit statement just before that COMMIT turns it into an ordinary
   * statement error, which Prisma does propagate.
   */
  async forTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const result = await fn(tx);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return result;
    });
  }
}
