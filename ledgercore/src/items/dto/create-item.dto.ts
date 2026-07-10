import { ItemType, TaxCode } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateItemDto {
  @IsString()
  @MinLength(1)
  sku: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsEnum(ItemType)
  type: ItemType;

  @IsEnum(TaxCode)
  taxCode: TaxCode;

  @IsString()
  unit: string;

  @IsInt()
  @IsPositive()
  defaultPriceMinor: number;

  @IsOptional()
  @IsUUID()
  incomeAccountId?: string;

  @IsOptional()
  @IsUUID()
  expenseAccountId?: string;
}
