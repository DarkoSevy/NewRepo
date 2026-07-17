import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateAndMatchDto {
  @IsUUID()
  glAccountId: string;

  @IsOptional()
  @IsString()
  memo?: string;
}
