import { TaxCode } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsEnum(TaxCode)
  taxCode?: TaxCode;

  @IsOptional()
  @IsInt()
  @IsPositive()
  defaultPriceMinor?: number;

  @IsOptional()
  @IsUUID()
  incomeAccountId?: string;

  @IsOptional()
  @IsUUID()
  expenseAccountId?: string;
}
