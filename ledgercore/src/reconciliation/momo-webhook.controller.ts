import { BadRequestException, Controller, Headers, Ip, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { MomoProvider } from '@prisma/client';
import { MomoWebhookService } from './momo-webhook.service';

const VALID_PROVIDERS: MomoProvider[] = ['MTN', 'AIRTEL'];

// No JwtAuthGuard here — this is an external MoMo callback, gated by HMAC
// signature + IP allowlist (MomoWebhookService), not a user session.
@Controller('webhooks/momo')
export class MomoWebhookController {
  constructor(private readonly webhook: MomoWebhookService) {}

  @Post(':provider')
  receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-momo-signature') signature: string | undefined,
    @Ip() ip: string,
  ) {
    const providerEnum = provider.toUpperCase() as MomoProvider;
    if (!VALID_PROVIDERS.includes(providerEnum)) {
      throw new BadRequestException(`Unknown provider: ${provider}`);
    }
    return this.webhook.receive(providerEnum, req.rawBody ?? Buffer.from(''), signature, ip);
  }
}
