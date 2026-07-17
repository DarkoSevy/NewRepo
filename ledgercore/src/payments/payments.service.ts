import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../journal/journal.service';
import { ControlAccountsService } from '../common/control-accounts.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
    private readonly controlAccounts: ControlAccountsService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.payment.findMany({ include: { allocations: true }, orderBy: { date: 'desc' } }),
    );
  }

  async findOne(tenantId: string, id: string) {
    const payment = await this.prisma.forTenant(tenantId, (tx) =>
      tx.payment.findUnique({ where: { id }, include: { allocations: true } }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async create(user: AuthenticatedUser, dto: CreatePaymentDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });

      const sumAllocated = dto.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
      if (sumAllocated !== dto.amountMinor) {
        throw new BadRequestException(
          `Allocations must sum exactly to the payment amount (${sumAllocated} != ${dto.amountMinor})`,
        );
      }

      for (const allocation of dto.allocations) {
        const hasInvoice = allocation.invoiceId !== undefined;
        const hasBill = allocation.billId !== undefined;
        if (hasInvoice === hasBill) {
          throw new BadRequestException('Each allocation must target exactly one of invoiceId or billId');
        }
        if (dto.direction === 'IN' && !hasInvoice) {
          throw new BadRequestException('IN payments must allocate to invoices');
        }
        if (dto.direction === 'OUT' && !hasBill) {
          throw new BadRequestException('OUT payments must allocate to bills');
        }
      }

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          direction: dto.direction,
          contactId: dto.contactId,
          method: dto.method,
          depositAccountId: dto.depositAccountId,
          amountMinor: BigInt(dto.amountMinor),
          date: new Date(dto.date),
          reference: dto.reference,
          createdBy: user.userId,
        },
      });

      for (const allocation of dto.allocations) {
        if (allocation.invoiceId) {
          await this.allocateToInvoice(tx, user.tenantId, payment.id, allocation.invoiceId, BigInt(allocation.amountMinor));
        } else {
          await this.allocateToBill(tx, user.tenantId, payment.id, allocation.billId!, BigInt(allocation.amountMinor));
        }
      }

      const controlAccountId = await this.controlAccounts.resolve(tx, user.tenantId, dto.direction === 'IN' ? 'AR' : 'AP');
      const glLines =
        dto.direction === 'IN'
          ? [
              { accountId: dto.depositAccountId, direction: 'DEBIT' as const, amountMinor: BigInt(dto.amountMinor), currency: tenant.baseCurrency },
              { accountId: controlAccountId, direction: 'CREDIT' as const, amountMinor: BigInt(dto.amountMinor), currency: tenant.baseCurrency },
            ]
          : [
              { accountId: controlAccountId, direction: 'DEBIT' as const, amountMinor: BigInt(dto.amountMinor), currency: tenant.baseCurrency },
              { accountId: dto.depositAccountId, direction: 'CREDIT' as const, amountMinor: BigInt(dto.amountMinor), currency: tenant.baseCurrency },
            ];

      await this.journal.postSystemEntry(tx, {
        tenantId: user.tenantId,
        entryDate: new Date(dto.date),
        memo: `Payment ${dto.direction} via ${dto.method}`,
        sourceDocumentRef: { type: 'PAYMENT', id: payment.id },
        lines: glLines,
        actorId: user.userId,
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'PAYMENT_RECORDED',
        entity: 'payment',
        entityId: payment.id,
        payload: { direction: dto.direction, amountMinor: dto.amountMinor },
      });

      return tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { allocations: true } });
    });
  }

  private async allocateToInvoice(tx: TenantTx, tenantId: string, paymentId: string, invoiceId: string, amountMinor: bigint) {
    const rows = await tx.$queryRaw<{ total_minor: bigint | string; status: string }[]>`
      SELECT total_minor, status FROM invoices WHERE id = ${invoiceId} FOR UPDATE
    `;
    if (!rows[0]) throw new NotFoundException(`Invoice ${invoiceId} not found`);
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(rows[0].status)) {
      throw new BadRequestException(`Invoice ${invoiceId} cannot accept payment (status ${rows[0].status})`);
    }
    const totalMinor = toBigInt(rows[0].total_minor);

    const paidRows = await tx.$queryRaw<{ paid: bigint | string | null }[]>`
      SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payment_allocations WHERE invoice_id = ${invoiceId}
    `;
    const creditedRows = await tx.$queryRaw<{ credited: bigint | string | null }[]>`
      SELECT COALESCE(SUM(total_minor), 0) AS credited FROM credit_notes WHERE original_invoice_id = ${invoiceId} AND status = 'ISSUED'
    `;
    const alreadyPaid = toBigInt(paidRows[0]?.paid ?? 0);
    const alreadyCredited = toBigInt(creditedRows[0]?.credited ?? 0);
    const openBalance = totalMinor - alreadyPaid - alreadyCredited;

    if (amountMinor > openBalance) {
      throw new BadRequestException(`Allocation ${amountMinor} exceeds invoice ${invoiceId} open balance ${openBalance}`);
    }

    await tx.paymentAllocation.create({
      data: { tenantId, paymentId, invoiceId, amountMinor },
    });

    const newPaidTotal = alreadyPaid + amountMinor;
    const newStatus = newPaidTotal + alreadyCredited >= totalMinor ? 'PAID' : 'PARTIALLY_PAID';
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: newStatus } });
  }

  private async allocateToBill(tx: TenantTx, tenantId: string, paymentId: string, billId: string, amountMinor: bigint) {
    const rows = await tx.$queryRaw<{ total_minor: bigint | string; status: string }[]>`
      SELECT total_minor, status FROM bills WHERE id = ${billId} FOR UPDATE
    `;
    if (!rows[0]) throw new NotFoundException(`Bill ${billId} not found`);
    if (!['APPROVED', 'PARTIALLY_PAID'].includes(rows[0].status)) {
      throw new BadRequestException(`Bill ${billId} cannot accept payment (status ${rows[0].status})`);
    }
    const totalMinor = toBigInt(rows[0].total_minor);

    const paidRows = await tx.$queryRaw<{ paid: bigint | string | null }[]>`
      SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM payment_allocations WHERE bill_id = ${billId}
    `;
    const alreadyPaid = toBigInt(paidRows[0]?.paid ?? 0);
    const openBalance = totalMinor - alreadyPaid;

    if (amountMinor > openBalance) {
      throw new BadRequestException(`Allocation ${amountMinor} exceeds bill ${billId} open balance ${openBalance}`);
    }

    await tx.paymentAllocation.create({
      data: { tenantId, paymentId, billId, amountMinor },
    });

    const newPaidTotal = alreadyPaid + amountMinor;
    const newStatus = newPaidTotal >= totalMinor ? 'PAID' : 'PARTIALLY_PAID';
    await tx.bill.update({ where: { id: billId }, data: { status: newStatus } });
  }
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value.toString());
}
