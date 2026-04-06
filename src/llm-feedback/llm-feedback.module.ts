import { Module, forwardRef } from '@nestjs/common';
import { LLMFeedbackService } from './llm-feedback.service';
import { FeedbackModule } from '../feedback/feedback.module';

@Module({
  imports: [forwardRef(() => FeedbackModule)],
  providers: [LLMFeedbackService],
  exports: [LLMFeedbackService],
})
export class LLMFeedbackModule { }
