import { IsNumber, IsString, IsUUID, MinLength } from 'class-validator';

export class StockAdjustmentDto {
  @IsUUID()
  itemId: string;

  /** Signed — positive to increase qty_on_hand, negative for shrinkage/write-off. */
  @IsNumber({ maxDecimalPlaces: 3 })
  qtyDelta: number;

  @IsString()
  @MinLength(1)
  reason: string;
}
