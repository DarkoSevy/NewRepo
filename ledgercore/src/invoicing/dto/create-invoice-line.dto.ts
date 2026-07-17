import { IsNumber, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

export class CreateInvoiceLineDto {
  @IsUUID()
  itemId: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  unitPriceMinor?: number;
}
