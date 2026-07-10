import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { RW_SME_TEMPLATE } from './rw-sme-template';

const NORMAL_BALANCE_BY_TYPE = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT',
  EXPENSE: 'DEBIT',
} as const;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    const flat = await this.prisma.forTenant(tenantId, (tx) =>
      tx.account.findMany({ orderBy: { code: 'asc' } }),
    );
    return { flat, tree: buildTree(flat) };
  }

  async create(user: AuthenticatedUser, dto: CreateAccountDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      if (dto.parentId) {
        const parent = await tx.account.findUnique({ where: { id: dto.parentId } });
        if (!parent) throw new NotFoundException('Parent account not found');
      }

      const account = await tx.account.create({
        data: {
          tenantId: user.tenantId,
          code: dto.code,
          name: dto.name,
          type: dto.type,
          normalBalance: NORMAL_BALANCE_BY_TYPE[dto.type],
          parentId: dto.parentId ?? null,
          isPostable: dto.isPostable ?? true,
        },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ACCOUNT_CREATED',
        entity: 'account',
        entityId: account.id,
        payload: account,
      });

      return account;
    });
  }

  async update(user: AuthenticatedUser, accountId: string, dto: UpdateAccountDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.account.findUnique({ where: { id: accountId } });
      if (!existing) throw new NotFoundException('Account not found');

      if (dto.parentId === accountId) {
        throw new BadRequestException('Account cannot be its own parent');
      }

      const updated = await tx.account.update({
        where: { id: accountId },
        data: { name: dto.name, parentId: dto.parentId },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ACCOUNT_UPDATED',
        entity: 'account',
        entityId: accountId,
        payload: { before: existing, after: updated },
      });

      return updated;
    });
  }

  async archive(user: AuthenticatedUser, accountId: string) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.account.findUnique({ where: { id: accountId } });
      if (!existing) throw new NotFoundException('Account not found');
      if (existing.archivedAt) return existing;

      const archived = await tx.account.update({
        where: { id: accountId },
        data: { archivedAt: new Date() },
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ACCOUNT_ARCHIVED',
        entity: 'account',
        entityId: accountId,
      });

      return archived;
    });
  }

  /** Idempotent: re-running the seed skips codes that already exist. */
  async seedTemplate(user: AuthenticatedUser, template: string) {
    if (template !== 'rw-sme') {
      throw new BadRequestException(`Unknown template: ${template}`);
    }

    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.account.findMany({ where: { tenantId: user.tenantId } });
      const existingCodes = new Set(existing.map((acc) => acc.code));
      const toCreate = RW_SME_TEMPLATE.filter((seed) => !existingCodes.has(seed.code));

      if (toCreate.length === 0) {
        return { created: 0, skipped: RW_SME_TEMPLATE.length };
      }

      await tx.account.createMany({
        data: toCreate.map((seed) => ({
          tenantId: user.tenantId,
          code: seed.code,
          name: seed.name,
          type: seed.type,
          normalBalance: seed.normalBalance,
          isPostable: true,
        })),
      });

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'ACCOUNTS_SEEDED',
        entity: 'account',
        payload: { template, created: toCreate.map((s) => s.code) },
      });

      return { created: toCreate.length, skipped: RW_SME_TEMPLATE.length - toCreate.length };
    });
  }
}

export interface AccountNode {
  [key: string]: unknown;
  children: AccountNode[];
}

function buildTree(accounts: any[]): AccountNode[] {
  const byId = new Map<string, AccountNode>();
  for (const acc of accounts) byId.set(acc.id, { ...acc, children: [] });

  const roots: AccountNode[] = [];
  for (const acc of accounts) {
    const node = byId.get(acc.id)!;
    if (acc.parentId && byId.has(acc.parentId)) {
      byId.get(acc.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
