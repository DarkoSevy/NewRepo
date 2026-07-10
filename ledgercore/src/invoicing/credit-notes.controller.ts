import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { CreditNotesService } from './credit-notes.service';
import { CreateCreditNoteDto } from './dto/create-credit-note.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('credit-notes')
export class CreditNotesController {
  constructor(private readonly creditNotes: CreditNotesService) {}

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.creditNotes.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCreditNoteDto) {
    return this.creditNotes.create(user, dto);
  }

  @Post(':id/issue')
  @Roles('OWNER', 'ACCOUNTANT')
  @HttpCode(HttpStatus.ACCEPTED)
  issue(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.creditNotes.issue(user, id);
  }
}
