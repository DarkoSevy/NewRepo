import { IsDateString, IsInt, IsUUID } from 'class-validator';

export class OpenReconciliationSessionDto {
  @IsUUID()
  financialAccountId: string;

  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;

  @IsInt()
  statementClosingBalanceMinor: number;
}
