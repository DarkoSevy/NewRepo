import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { GenericCsvParser } from './statement-parsing/generic-csv.parser';
import { CSV_TEMPLATES } from './statement-parsing/templates';
import { CsvColumnMapping } from './statement-parsing/statement-parser.interface';
import { sha256Hex, statementLineHash } from './hashing';
import { MatchingService } from './matching.service';

function resolveMapping(template?: string, mapping?: CsvColumnMapping): CsvColumnMapping {
  if (mapping) return mapping;
  if (template) {
    const preset = CSV_TEMPLATES[template];
    if (!preset) throw new BadRequestException(`Unknown parser template: ${template}`);
    return preset;
  }
  throw new BadRequestException('Provide either ?template= or a column-mapping payload');
}

@Injectable()
export class StatementImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly parser: GenericCsvParser,
    private readonly matching: MatchingService,
  ) {}

  /** Dry-run parse — never touches the database. */
  preview(financialAccountId: string, buffer: Buffer, template?: string, mapping?: CsvColumnMapping) {
    const resolved = resolveMapping(template, mapping);
    const parsed = this.parser.parse(buffer, resolved);
    return {
      totalLines: parsed.lines.length,
      preview: parsed.lines.slice(0, 20).map((l) => ({
        ...l,
        amountMinor: l.amountMinor.toString(),
        runningBalanceMinor: l.runningBalanceMinor?.toString() ?? null,
      })),
    };
  }

  async commit(
    user: AuthenticatedUser,
    financialAccountId: string,
    filename: string,
    buffer: Buffer,
    template?: string,
    mapping?: CsvColumnMapping,
  ) {
    const fileHash = sha256Hex(buffer);

    return this.prisma.forTenant(user.tenantId, async (tx) => {
      const financialAccount = await tx.financialAccount.findUnique({ where: { id: financialAccountId } });
      if (!financialAccount) throw new NotFoundException('Financial account not found');

      const existingImport = await tx.statementImport.findUnique({
        where: { financialAccountId_fileHash: { financialAccountId, fileHash } },
      });
      if (existingImport) {
        return { duplicate: true, message: 'This exact file was already imported', importId: existingImport.id };
      }

      const resolved = resolveMapping(template, mapping);
      const parsed = this.parser.parse(buffer, resolved);
      if (parsed.lines.length === 0) throw new BadRequestException('No lines parsed from this file');

      const dates = parsed.lines.map((l) => l.lineDate.getTime());
      const periodStart = new Date(Math.min(...dates));
      const periodEnd = new Date(Math.max(...dates));
      const opening = parsed.lines[0]?.runningBalanceMinor ?? 0n;
      const closing = parsed.lines[parsed.lines.length - 1]?.runningBalanceMinor ?? 0n;

      const statementImport = await tx.statementImport.create({
        data: {
          tenantId: user.tenantId,
          financialAccountId,
          filename,
          fileHash,
          periodStart,
          periodEnd,
          openingBalanceMinor: opening,
          closingBalanceMinor: closing,
          lineCount: parsed.lines.length,
          importedBy: user.userId,
        },
      });

      const newLineIds: string[] = [];
      let duplicateCount = 0;

      for (const line of parsed.lines) {
        const hash = statementLineHash({
          financialAccountId,
          lineDate: line.lineDate,
          amountMinor: line.amountMinor,
          direction: line.direction,
          externalRef: line.externalRef,
          description: line.description,
        });

        const existingLine = await tx.statementLine.findUnique({
          where: { financialAccountId_lineHash: { financialAccountId, lineHash: hash } },
        });
        if (existingLine) {
          duplicateCount++;
          continue;
        }

        const created = await tx.statementLine.create({
          data: {
            tenantId: user.tenantId,
            importId: statementImport.id,
            financialAccountId,
            lineDate: line.lineDate,
            description: line.description,
            externalRef: line.externalRef,
            amountMinor: line.amountMinor,
            direction: line.direction,
            runningBalanceMinor: line.runningBalanceMinor,
            lineHash: hash,
          },
        });
        newLineIds.push(created.id);
      }

      await this.matching.runAutoMatch(tx, user.tenantId, financialAccountId, newLineIds);

      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actorId: user.userId,
        action: 'STATEMENT_IMPORTED',
        entity: 'statement_import',
        entityId: statementImport.id,
        payload: { filename, newLines: newLineIds.length, duplicateLines: duplicateCount },
      });

      return {
        duplicate: false,
        import: statementImport,
        newLines: newLineIds.length,
        duplicateLines: duplicateCount,
      };
    });
  }

  async findOne(tenantId: string, id: string) {
    const record = await this.prisma.forTenant(tenantId, (tx) =>
      tx.statementImport.findUnique({ where: { id }, include: { lines: true } }),
    );
    if (!record) throw new NotFoundException('Statement import not found');
    return record;
  }
}
