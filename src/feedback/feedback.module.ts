import { Module } from '@nestjs/common';
import { FeedbackGateway } from './feedback.gateway';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackGrpcServer } from './feedback.grpc.server';
import { forwardRef } from '@nestjs/common';
import { LLMFeedbackModule } from '../llm-feedback/llm-feedback.module';
import { AuthModule } from '../auth/auth.module';
import { SessionsModule } from '../sessions/sessions.module';
import { MonitorModule } from '../monitor/monitor.module';

@Module({
  imports: [
    forwardRef(() => LLMFeedbackModule),
    AuthModule,
    SessionsModule,
    forwardRef(() => MonitorModule),
  ],
  providers: [FeedbackGateway, FeedbackService, FeedbackGrpcServer],
  controllers: [FeedbackController],
  exports: [FeedbackService, FeedbackGrpcServer, FeedbackGateway],
})
export class FeedbackModule {}
