import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PaymentDirection, PaymentMethod } from '@prisma/client';

export class PaymentAllocationDto {
  @IsOptional()
  @IsUUID()
  invoiceId?: string;

  @IsOptional()
  @IsUUID()
  billId?: string;

  @IsInt()
  @IsPositive()
  amountMinor: number;
}

export class CreatePaymentDto {
  @IsEnum(PaymentDirection)
  direction: PaymentDirection;

  @IsOptional()
  @IsUUID()
  contactId?: string;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsUUID()
  depositAccountId: string;

  @IsInt()
  @IsPositive()
  amountMinor: number;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentAllocationDto)
  allocations: PaymentAllocationDto[];
}
