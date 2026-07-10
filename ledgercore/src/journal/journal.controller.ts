import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { EntryStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { JournalService } from './journal.service';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { UpdateJournalEntryDto } from './dto/update-journal-entry.dto';
import { ReverseJournalEntryDto } from './dto/reverse-journal-entry.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('journal-entries')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: EntryStatus,
    @Query('account') accountId?: string,
  ) {
    return this.journal.findAll(user.tenantId, { status, accountId });
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.journal.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateJournalEntryDto) {
    return this.journal.create(user, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateJournalEntryDto,
  ) {
    return this.journal.update(user, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.journal.remove(user, id);
  }

  @Post(':id/post')
  @Roles('OWNER', 'ACCOUNTANT')
  post(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.journal.post(user, id);
  }

  @Post(':id/reverse')
  @Roles('OWNER', 'ACCOUNTANT')
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReverseJournalEntryDto,
  ) {
    return this.journal.reverse(user, id, dto?.date);
  }
}
