import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EbmService } from '../ebm/ebm.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ebm: EbmService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.item.findMany({ orderBy: { sku: 'asc' } }));
  }

  async findOne(tenantId: string, id: string) {
    const item = await this.prisma.forTenant(tenantId, (tx) => tx.item.findUnique({ where: { id } }));
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  create(user: AuthenticatedUser, dto: CreateItemDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const item = await tx.item.create({
        data: {
          tenantId: user.tenantId,
          sku: dto.sku,
          name: dto.name,
          type: dto.type,
          taxCode: dto.taxCode,
          unit: dto.unit,
          defaultPriceMinor: BigInt(dto.defaultPriceMinor),
          incomeAccountId: dto.incomeAccountId,
          expenseAccountId: dto.expenseAccountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ITEM_CREATED',
        entity: 'item',
        entityId: item.id,
      });
      return item;
    });
  }

  update(user: AuthenticatedUser, id: string, dto: UpdateItemDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.item.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Item not found');

      const updated = await tx.item.update({
        where: { id },
        data: {
          name: dto.name,
          taxCode: dto.taxCode,
          defaultPriceMinor: dto.defaultPriceMinor !== undefined ? BigInt(dto.defaultPriceMinor) : undefined,
          incomeAccountId: dto.incomeAccountId,
          expenseAccountId: dto.expenseAccountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ITEM_UPDATED',
        entity: 'item',
        entityId: id,
      });
      return updated;
    });
  }

  archive(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.item.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Item not found');
      if (existing.archivedAt) return existing;

      const archived = await tx.item.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ITEM_ARCHIVED',
        entity: 'item',
        entityId: id,
      });
      return archived;
    });
  }

  /** Registers the item with the VSDC (or no-ops under NullDriver) — required before first sale when ebm_mode = VSDC. */
  registerEbm(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const item = await tx.item.findUnique({ where: { id } });
      if (!item) throw new NotFoundException('Item not found');

      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: user.tenantId } });

      const result = await this.ebm.registerItem(tx, user.tenantId, tenant.ebmMode, {
        sku: item.sku,
        name: item.name,
        type: item.type,
        taxCode: item.taxCode,
        unit: item.unit,
      });

      if (result.outcome !== 'OK' || !result.data) {
        throw new BadRequestException(result.errorMessage ?? 'EBM item registration failed');
      }

      const updated = await tx.item.update({
        where: { id },
        data: {
          rraItemCode: result.data.rraItemCode,
          rraItemClassCode: result.data.rraItemClassCode,
          ebmRegisteredAt: new Date(),
        },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ITEM_EBM_REGISTERED',
        entity: 'item',
        entityId: id,
        payload: { rraItemCode: result.data.rraItemCode },
      });

      return updated;
    });
  }
}
