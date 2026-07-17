import { MatchRuleAction, PaymentDirection } from '@prisma/client';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class MatchRulePredicateDto {
  @IsOptional()
  @IsString()
  descriptionContains?: string;

  @IsOptional()
  @IsEnum(PaymentDirection)
  direction?: PaymentDirection;

  @IsOptional()
  @IsInt()
  amountMin?: number;

  @IsOptional()
  @IsInt()
  amountMax?: number;

  @IsOptional()
  @IsString()
  refPattern?: string;
}

export class CreateMatchRuleDto {
  @IsOptional()
  @IsUUID()
  financialAccountId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsObject()
  predicate: MatchRulePredicateDto;

  @IsEnum(MatchRuleAction)
  action: MatchRuleAction;

  @IsOptional()
  @IsObject()
  createSpec?: { glAccountId: string; taxCode?: string; memoTemplate?: string };

  @IsOptional()
  enabled?: boolean;
}
