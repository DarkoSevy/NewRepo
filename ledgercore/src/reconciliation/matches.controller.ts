import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { MatchesService } from './matches.service';
import { CreateManualMatchDto } from './dto/create-manual-match.dto';
import { ExcludeLineDto } from './dto/exclude-line.dto';
import { CreateAndMatchDto } from './dto/create-and-match.dto';
import { RecordSweepDto } from './dto/record-sweep.dto';

class BulkConfirmDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  matchIds: string[];
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Post('matches')
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateManualMatchDto) {
    return this.matches.createManual(user, dto);
  }

  @Post('matches/:id/confirm')
  @Roles('OWNER', 'ACCOUNTANT')
  confirm(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.confirm(user, id);
  }

  @Post('matches/bulk-confirm')
  @Roles('OWNER', 'ACCOUNTANT')
  bulkConfirm(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkConfirmDto) {
    return this.matches.bulkConfirm(user, dto.matchIds);
  }

  @Delete('matches/:id')
  @Roles('OWNER', 'ACCOUNTANT')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.matches.remove(user, id);
  }

  @Post('statement-lines/:id/exclude')
  @Roles('OWNER', 'ACCOUNTANT')
  exclude(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ExcludeLineDto) {
    return this.matches.excludeStatementLine(user, id, dto.reason);
  }

  @Post('statement-lines/:id/create-and-match')
  @Roles('OWNER', 'ACCOUNTANT')
  createAndMatch(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: CreateAndMatchDto) {
    return this.matches.createAndMatch(user, id, dto);
  }

  @Post('momo/record-sweep')
  @Roles('OWNER', 'ACCOUNTANT')
  recordSweep(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordSweepDto) {
    return this.matches.recordSweep(user, dto);
  }
}
