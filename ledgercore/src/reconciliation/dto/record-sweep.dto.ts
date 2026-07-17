import { IsUUID } from 'class-validator';

export class RecordSweepDto {
  @IsUUID()
  bankLineId: string;

  @IsUUID()
  momoLineId: string;
}
