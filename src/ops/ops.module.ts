import { Module } from '@nestjs/common';

import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

@Module({
  imports: [PrismaModule, TenancyModule],
  controllers: [OpsController],
  providers: [OpsService, PlatformAdminGuard],
})
export class OpsModule {}
