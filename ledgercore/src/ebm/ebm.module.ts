import { Module } from '@nestjs/common';
import { EbmService } from './ebm.service';
import { NullDriver } from './drivers/null.driver';
import { VsdcDriver } from './drivers/vsdc.driver';
import { EbmController } from './ebm.controller';

@Module({
  providers: [EbmService, NullDriver, VsdcDriver],
  controllers: [EbmController],
  exports: [EbmService],
})
export class EbmModule {}
