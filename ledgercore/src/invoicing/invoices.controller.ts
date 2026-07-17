import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InvoiceStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { UpdateInvoiceDto } from './dto/update-invoice.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: InvoiceStatus,
    @Query('contact') contactId?: string,
  ) {
    return this.invoices.list(user.tenantId, { status, contactId });
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoices.findOne(user.tenantId, id);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(user, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ACCOUNTANT')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) {
    return this.invoices.update(user, id, dto);
  }

  @Post(':id/issue')
  @Roles('OWNER', 'ACCOUNTANT')
  @HttpCode(HttpStatus.ACCEPTED)
  issue(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoices.issue(user, id);
  }

  @Post(':id/reset-draft')
  @Roles('OWNER', 'ACCOUNTANT')
  resetToDraft(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.invoices.resetToDraft(user, id);
  }

  @Get(':id/receipt.pdf')
  async receiptPdf(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const pdf = await this.invoices.getReceiptPdf(user.tenantId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${id}.pdf"`);
    res.send(pdf);
  }
}
