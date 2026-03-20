import { Module } from '@nestjs/common';
import { FeedbackGateway } from './feedback.gateway';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackGrpcServer } from './feedback.grpc.server';
import { TextAnalysisFeedbackService } from './text-analysis-feedback/text-analysis-feedback.service';
import { MeetingStateStore } from './text-analysis-feedback/state-store';
import { ParticipantContextProvider } from './text-analysis-feedback/context-provider';

@Module({
  providers: [
    FeedbackGateway,
    FeedbackService,
    FeedbackGrpcServer,
    TextAnalysisFeedbackService,
    MeetingStateStore,
    ParticipantContextProvider,
  ],
  controllers: [FeedbackController],
  exports: [FeedbackService, FeedbackGrpcServer, TextAnalysisFeedbackService],
})
export class FeedbackModule {}
