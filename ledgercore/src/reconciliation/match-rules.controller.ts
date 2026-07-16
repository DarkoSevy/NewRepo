import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { MatchRulesService } from './match-rules.service';
import { CreateMatchRuleDto } from './dto/create-match-rule.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('match-rules')
export class MatchRulesController {
  constructor(private readonly rules: MatchRulesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.rules.list(user.tenantId);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMatchRuleDto) {
    return this.rules.create(user, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: Partial<CreateMatchRuleDto>) {
    return this.rules.update(user, id, dto);
  }

  @Post(':id/test')
  test(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.rules.test(user.tenantId, id);
  }
}
