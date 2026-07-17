import { Injectable } from '@nestjs/common';
import { TenantTx } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  async record(
    tx: TenantTx,
    params: {
      tenantId: string;
      actorId?: string | null;
      action: string;
      entity: string;
      entityId?: string | null;
      payload?: unknown;
    },
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actorId: params.actorId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId ?? null,
        payload: params.payload === undefined ? undefined : (params.payload as any),
      },
    });
  }
}
