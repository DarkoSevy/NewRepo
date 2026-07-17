import { IsString, MinLength } from 'class-validator';

export class ExcludeLineDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
