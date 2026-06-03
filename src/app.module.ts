import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { FeedbackModule } from './feedback/feedback.module';
import { EgressModule } from './egress/egress.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { LLMFeedbackModule } from './llm-feedback/llm-feedback.module';
import { BillingModule } from './billing/billing.module';
import { MembersModule } from './members/members.module';
import { InvitationsModule } from './invitations/invitations.module';
import { PlaybooksModule } from './playbooks/playbooks.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { OpsModule } from './ops/ops.module';

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
    PlatformAdminModule,
    OpsModule,
    FeedbackModule,
    EgressModule,
    PipelineModule,
    LLMFeedbackModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
