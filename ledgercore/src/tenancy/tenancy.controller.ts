import { Body, Controller, Post } from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { CreateTenantDto } from './dto/create-tenant.dto';

// Tenant provisioning is a platform-admin operation with no tenant context
// of its own yet, so it deliberately sits outside the JWT guard used by
// every other controller. Gate this route at the network/deployment layer
// (internal-only ingress, admin API key, etc.) before exposing it publicly.
@Controller('tenants')
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.tenancy.createTenant(dto);
  }
}
