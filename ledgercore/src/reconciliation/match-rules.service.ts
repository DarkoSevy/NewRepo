import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreateMatchRuleDto } from './dto/create-match-rule.dto';

@Injectable()
export class MatchRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(tenantId: string) {
    return this.prisma.forTenant(tenantId, (tx) => tx.matchRule.findMany({ orderBy: { priority: 'asc' } }));
  }

  create(user: AuthenticatedUser, dto: CreateMatchRuleDto) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const rule = await tx.matchRule.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId: dto.financialAccountId,
          priority: dto.priority ?? 100,
          predicate: dto.predicate as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          action: dto.action,
          createSpec: dto.createSpec as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          enabled: dto.enabled ?? true,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'MATCH_RULE_CREATED',
        entity: 'match_rule',
        entityId: rule.id,
      });
      return rule;
    });
  }

  async update(user: AuthenticatedUser, id: string, dto: Partial<CreateMatchRuleDto>) {
    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const existing = await tx.matchRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Match rule not found');
      const updated = await tx.matchRule.update({
        where: { id },
        data: {
          priority: dto.priority,
          predicate: dto.predicate as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          action: dto.action,
          createSpec: dto.createSpec as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          enabled: dto.enabled,
        },
      });
      return updated;
    });
  }

  /** Dry-run: which currently-UNMATCHED lines would this rule hit, without creating anything. */
  async test(tenantId: string, id: string) {
    return this.prisma.forTenant(tenantId, async (tx) => {
      const rule = await tx.matchRule.findUnique({ where: { id } });
      if (!rule) throw new NotFoundException('Match rule not found');
      const predicate = rule.predicate as {
        descriptionContains?: string;
        direction?: 'IN' | 'OUT';
        amountMin?: number;
        amountMax?: number;
        refPattern?: string;
      };

      const candidates = await tx.statementLine.findMany({
        where: {
          tenantId,
          status: 'UNMATCHED',
          financialAccountId: rule.financialAccountId ?? undefined,
          direction: predicate.direction,
        },
      });

      const matched = candidates.filter((line) => {
        if (predicate.descriptionContains && !line.description.toUpperCase().includes(predicate.descriptionContains.toUpperCase())) return false;
        if (predicate.amountMin !== undefined && line.amountMinor < BigInt(predicate.amountMin)) return false;
        if (predicate.amountMax !== undefined && line.amountMinor > BigInt(predicate.amountMax)) return false;
        if (predicate.refPattern && !new RegExp(predicate.refPattern).test(line.description)) return false;
        return true;
      });

      return { wouldMatch: matched.length, lines: matched };
    });
  }
}
