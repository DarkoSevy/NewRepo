import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { ItemsService } from './items.service';
import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.items.list(user.tenantId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.items.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateItemDto) {
    return this.items.create(user, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.items.update(user, id, dto);
  }

  @Post(':id/archive')
  @Roles('OWNER', 'ACCOUNTANT')
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.items.archive(user, id);
  }

  @Post(':id/register-ebm')
  @Roles('OWNER', 'ACCOUNTANT')
  registerEbm(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.items.registerEbm(user, id);
  }
}
