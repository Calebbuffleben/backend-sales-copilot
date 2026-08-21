import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import { SpecialistsAdminController } from './specialists-admin.controller';
import { SpecialistsInternalController } from './specialists-internal.controller';
import { SpecialistsTenantController } from './specialists-tenant.controller';
import { SpecialistsService } from './specialists.service';

@Module({
  imports: [PrismaModule, TenancyModule, AuthModule],
  controllers: [
    SpecialistsAdminController,
    SpecialistsInternalController,
    SpecialistsTenantController,
  ],
  providers: [SpecialistsService, PlatformAdminGuard],
  exports: [SpecialistsService],
})
export class SpecialistsModule {}
