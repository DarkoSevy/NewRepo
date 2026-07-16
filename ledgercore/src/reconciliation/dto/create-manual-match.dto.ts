import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class CreateManualMatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  statementLineIds: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  journalLineIds: string[];
}
