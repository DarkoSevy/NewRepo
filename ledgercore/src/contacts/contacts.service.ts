import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) =>
      tx.contact.findMany({ orderBy: { name: 'asc' } }),
    );
  }

  async findOne(tenantId: string, id: string) {
    const contact = await this.prisma.forTenant(tenantId, (tx) => tx.contact.findUnique({ where: { id } }));
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  create(user: AuthenticatedUser, dto: CreateContactDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const contact = await tx.contact.create({
        data: {
          tenantId: user.tenantId,
          kind: dto.kind,
          name: dto.name,
          tin: dto.tin,
          email: dto.email,
          phone: dto.phone,
          address: dto.address,
          momoNumber: dto.momoNumber,
          paymentTermsDays: dto.paymentTermsDays ?? 30,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'CONTACT_CREATED',
        entity: 'contact',
        entityId: contact.id,
      });
      return contact;
    });
  }

  update(user: AuthenticatedUser, id: string, dto: UpdateContactDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.contact.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Contact not found');

      const updated = await tx.contact.update({ where: { id }, data: dto });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'CONTACT_UPDATED',
        entity: 'contact',
        entityId: id,
      });
      return updated;
    });
  }

  archive(user: AuthenticatedUser, id: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.contact.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Contact not found');
      if (existing.archivedAt) return existing;

      const archived = await tx.contact.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'CONTACT_ARCHIVED',
        entity: 'contact',
        entityId: id,
      });
      return archived;
    });
  }
}
