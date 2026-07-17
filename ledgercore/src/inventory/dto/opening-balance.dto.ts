import { IsInt, IsNumber, IsPositive, IsUUID } from 'class-validator';

export class OpeningBalanceDto {
  @IsUUID()
  itemId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  qty: number;

  @IsInt()
  @IsPositive()
  unitCostMinor: number;
}
