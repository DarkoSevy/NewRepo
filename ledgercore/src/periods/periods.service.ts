import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, TenantTx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';

@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.accountingPeriod.findMany({ orderBy: { startDate: 'asc' } }),
    );
  }

  async generate(user: AuthenticatedUser, year: number) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const months = Array.from({ length: 12 }, (_, i) => {
        const start = new Date(Date.UTC(year, i, 1));
        const end = new Date(Date.UTC(year, i + 1, 0));
        return { startDate: start, endDate: end };
      });

      const existing = await tx.accountingPeriod.findMany({
        where: { startDate: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
      });
      if (existing.length > 0) {
        throw new BadRequestException(`Periods for ${year} already exist`);
      }

      await tx.accountingPeriod.createMany({
        data: months.map((m) => ({
          tenantId: user.tenantId,
          startDate: m.startDate,
          endDate: m.endDate,
          status: 'OPEN',
        })),
      });

      const created = await tx.accountingPeriod.findMany({
        where: { tenantId: user.tenantId, startDate: { gte: months[0].startDate, lte: months[11].startDate } },
        orderBy: { startDate: 'asc' },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'PERIODS_GENERATED',
        entity: 'accounting_period',
        payload: { year },
      });

      return created;
    });
  }

  async close(user: AuthenticatedUser, periodId: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const period = await tx.accountingPeriod.findUnique({ where: { id: periodId } });
      if (!period) throw new NotFoundException('Period not found');
      if (period.status === 'CLOSED') return period;

      const closed = await tx.accountingPeriod.update({
        where: { id: periodId },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: user.userId },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'PERIOD_CLOSED',
        entity: 'accounting_period',
        entityId: periodId,
      });

      return closed;
    });
  }

  async reopen(user: AuthenticatedUser, periodId: string) {
    if (user.role !== 'OWNER') {
      throw new ForbiddenException('Only OWNER can reopen a closed period');
    }

    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const period = await tx.accountingPeriod.findUnique({ where: { id: periodId } });
      if (!period) throw new NotFoundException('Period not found');
      if (period.status === 'OPEN') return period;

      const reopened = await tx.accountingPeriod.update({
        where: { id: periodId },
        data: { status: 'OPEN', closedAt: null, closedBy: null },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'PERIOD_REOPENED',
        entity: 'accounting_period',
        entityId: periodId,
      });

      return reopened;
    });
  }

  /** Throws if `date` doesn't fall in an OPEN period for the tenant. Callers must already be inside a `forTenant` transaction. */
  async assertDateInOpenPeriod(tx: TenantTx, tenantId: string, date: Date) {
    const period = await tx.accountingPeriod.findFirst({
      where: { tenantId, startDate: { lte: date }, endDate: { gte: date } },
    });
    if (!period) {
      throw new BadRequestException(`No accounting period covers ${date.toISOString().slice(0, 10)}`);
    }
    if (period.status !== 'OPEN') {
      throw new BadRequestException(`Accounting period covering ${date.toISOString().slice(0, 10)} is CLOSED`);
    }
    return period;
  }
}
