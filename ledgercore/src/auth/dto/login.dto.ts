import { IsEmail, IsString, IsUUID } from 'class-validator';

export class LoginDto {
  @IsUUID()
  tenantId: string;

  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
