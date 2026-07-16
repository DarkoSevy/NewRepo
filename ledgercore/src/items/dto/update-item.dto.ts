import { TaxCode } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';

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

  /** Enables inventory tracking (spec Phase 3 §6) — set alongside inventoryAccountId, then call POST /stock/opening-balances. Can only be turned on for GOODS items with no stock movements yet. */
  @IsOptional()
  @IsBoolean()
  tracked?: boolean;

  @IsOptional()
  @IsUUID()
  inventoryAccountId?: string;
}
