import { Global, Module } from '@nestjs/common';
import { TaxRatesService } from './tax-rates.service';

@Global()
@Module({
  providers: [TaxRatesService],
  exports: [TaxRatesService],
})
export class TaxModule {}
