import { Module } from '@nestjs/common';
import { FeedbackGateway } from './feedback.gateway';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackGrpcServer } from './feedback.grpc.server';
import { forwardRef } from '@nestjs/common';
import { LLMFeedbackModule } from '../llm-feedback/llm-feedback.module';

@Module({
  imports: [forwardRef(() => LLMFeedbackModule)],
  providers: [
    FeedbackGateway,
    FeedbackService,
    FeedbackGrpcServer,
  ],
  controllers: [FeedbackController],
  exports: [FeedbackService, FeedbackGrpcServer, FeedbackGateway],
})
export class FeedbackModule {}
