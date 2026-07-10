import { IsString, MinLength } from 'class-validator';

export class InitDeviceDto {
  @IsString()
  @MinLength(1)
  tin: string;

  @IsString()
  @MinLength(1)
  branchId: string;

  @IsString()
  @MinLength(1)
  deviceSerial: string;
}
