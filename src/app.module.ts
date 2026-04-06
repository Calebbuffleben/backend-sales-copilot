import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { FeedbackModule } from './feedback/feedback.module';
import { EgressModule } from './egress/egress.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { LLMFeedbackModule } from './llm-feedback/llm-feedback.module';

@Module({
  imports: [PrismaModule, FeedbackModule, EgressModule, PipelineModule, LLMFeedbackModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
