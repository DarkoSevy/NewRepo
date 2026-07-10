import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.contacts.list(user.tenantId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.contacts.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContactDto) {
    return this.contacts.create(user, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateContactDto) {
    return this.contacts.update(user, id, dto);
  }

  @Post(':id/archive')
  @Roles('OWNER', 'ACCOUNTANT')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.contacts.archive(user, id);
  }
}
