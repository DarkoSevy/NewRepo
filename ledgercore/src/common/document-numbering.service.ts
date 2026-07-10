import { Injectable } from '@nestjs/common';
import { TenantTx } from '../prisma/prisma.service';

@Injectable()
export class DocumentNumberingService {
  /** Assigns the next gap-free number for `docType` ('INVOICE' | 'CREDIT_NOTE' | 'BILL'). Must run inside the transaction that finalizes the document: locks the per-tenant/doc-type counter row so concurrent finalizes serialize instead of racing. */
  async next(tx: TenantTx, tenantId: string, docType: string): Promise<bigint> {
    await tx.documentNoSequence.upsert({
      where: { tenantId_docType: { tenantId, docType } },
      create: { tenantId, docType, lastNo: 0n },
      update: {},
    });
    const rows = await tx.$queryRaw<{ last_no: bigint }[]>`
      SELECT last_no FROM document_no_sequences WHERE tenant_id = ${tenantId} AND doc_type = ${docType} FOR UPDATE
    `;
    const next = rows[0].last_no + 1n;
    await tx.$executeRaw`
      UPDATE document_no_sequences SET last_no = ${next} WHERE tenant_id = ${tenantId} AND doc_type = ${docType}
    `;
    return next;
  }
}
