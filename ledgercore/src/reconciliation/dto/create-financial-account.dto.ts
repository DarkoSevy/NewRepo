import { FinancialAccountKind } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateFinancialAccountDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsEnum(FinancialAccountKind)
  kind: FinancialAccountKind;

  @IsUUID()
  glAccountId: string;

  @IsOptional()
  @IsString()
  bankCode?: string;

  @IsOptional()
  @IsString()
  accountNumberMasked?: string;

  @IsOptional()
  @IsString()
  parserTemplate?: string;
}
