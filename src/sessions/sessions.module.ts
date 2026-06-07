import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SessionsService } from './sessions.service';

@Module({
  imports: [PrismaModule, TenancyModule],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
