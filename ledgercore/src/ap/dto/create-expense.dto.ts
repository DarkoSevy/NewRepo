import { TaxCode } from '@prisma/client';
import { IsDateString, IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

export class CreateExpenseDto {
  @IsOptional()
  @IsUUID()
  contactId?: string;

  @IsUUID()
  expenseAccountId: string;

  @IsUUID()
  paidFromAccountId: string;

  @IsEnum(TaxCode)
  taxCode: TaxCode;

  @IsDateString()
  date: string;

  /** Gross (tax-inclusive) amount — expense receipts are always entered as a total. */
  @IsInt()
  @IsPositive()
  amountMinor: number;

  @IsOptional()
  @IsString()
  memo?: string;

  @IsOptional()
  @IsString()
  receiptAttachmentRef?: string;
}
