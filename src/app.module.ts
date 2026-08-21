import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { FeedbackModule } from './feedback/feedback.module';
import { LLMFeedbackModule } from './llm-feedback/llm-feedback.module';
import { BillingModule } from './billing/billing.module';
import { MembersModule } from './members/members.module';
import { InvitationsModule } from './invitations/invitations.module';
import { PlaybooksModule } from './playbooks/playbooks.module';
import { SpecialistsModule } from './specialists/specialists.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { OpsModule } from './ops/ops.module';
import { SellerRoomsModule } from './seller-rooms/seller-rooms.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
    ]),
    TenancyModule,
    PrismaModule,
    AuthModule,
    BillingModule,
    MembersModule,
    InvitationsModule,
    PlaybooksModule,
    SpecialistsModule,
    SellerRoomsModule,
    PlatformAdminModule,
    OpsModule,
    FeedbackModule,
    LLMFeedbackModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
