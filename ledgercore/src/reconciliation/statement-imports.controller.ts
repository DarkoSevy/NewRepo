import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/interfaces/request-context';
import { StatementImportsService } from './statement-imports.service';

// Simplification vs. the spec's stateful "POST creates a pending import,
// then GET :id/preview, then POST :id/commit" flow: preview is a stateless
// dry-run over the uploaded bytes (nothing persisted), and the main POST
// commits directly. Both capabilities exist; the REST shape is flatter.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('statement-imports')
export class StatementImportsController {
  constructor(private readonly imports: StatementImportsService) {}

  @Post('preview')
  @Roles('OWNER', 'ACCOUNTANT')
  @UseInterceptors(FileInterceptor('file'))
  preview(
    @UploadedFile() file: Express.Multer.File,
    @Body('financialAccountId') financialAccountId: string,
    @Query('template') template: string | undefined,
    @Body('mapping') mapping: string | undefined,
  ) {
    return this.imports.preview(financialAccountId, file.buffer, template, mapping ? JSON.parse(mapping) : undefined);
  }

  @Post()
  @Roles('OWNER', 'ACCOUNTANT')
  @UseInterceptors(FileInterceptor('file'))
  commit(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('financialAccountId') financialAccountId: string,
    @Query('template') template: string | undefined,
    @Body('mapping') mapping: string | undefined,
  ) {
    return this.imports.commit(
      user,
      financialAccountId,
      file.originalname,
      file.buffer,
      template,
      mapping ? JSON.parse(mapping) : undefined,
    );
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.imports.findOne(user.tenantId, id);
  }
}
