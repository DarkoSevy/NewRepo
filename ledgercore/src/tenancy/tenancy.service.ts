import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TaxRatesService } from '../tax/tax-rates.service';

@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly taxRates: TaxRatesService,
  ) {}

  /**
   * Bootstraps a brand-new tenant with its first OWNER user and a
   * zeroed entry-number sequence. `tenants` itself carries no RLS policy
   * (there is no tenant context yet to scope it by), so this is the one
   * write path that must be gated at the network/deployment layer rather
   * than by JWT role.
   */
  async createTenant(params: { name: string; ownerEmail: string; ownerPassword: string }) {
    const tenant = await this.prisma.tenant.create({
      data: { name: params.name },
    });

    const passwordHash = await bcrypt.hash(params.ownerPassword, 12);

    const owner = await this.prisma.forTenant(tenant.id, async (tx) => {
      await tx.entryNoSequence.create({ data: { tenantId: tenant.id, lastNo: 0n } });
      await this.taxRates.seedDefaults(tx, tenant.id, tenant.createdAt);
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: params.ownerEmail,
          passwordHash,
          role: 'OWNER',
        },
      });
      await this.audit.record(tx, {
        tenantId: tenant.id,
        actorId: user.id,
        action: 'TENANT_CREATED',
        entity: 'tenant',
        entityId: tenant.id,
        payload: { name: tenant.name, ownerEmail: params.ownerEmail },
      });
      return user;
    });

    return { tenant, owner: { id: owner.id, email: owner.email, role: owner.role } };
  }
}
