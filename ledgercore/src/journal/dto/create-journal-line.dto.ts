import { LineDirection } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, Length } from 'class-validator';

export class CreateJournalLineDto {
  @IsUUID()
  accountId: string;

  @IsEnum(LineDirection)
  direction: LineDirection;

  @IsInt()
  @IsPositive()
  amountMinor: number;

  @IsString()
  @Length(3, 3)
  currency: string;

  @IsOptional()
  @IsString()
  memo?: string;
}
