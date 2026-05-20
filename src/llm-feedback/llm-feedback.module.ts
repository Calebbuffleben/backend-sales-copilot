import { Module, forwardRef } from '@nestjs/common';
import { LLMFeedbackService } from './llm-feedback.service';
import { FeedbackModule } from '../feedback/feedback.module';
import { PlaybooksModule } from '../playbooks/playbooks.module';

@Module({
  imports: [forwardRef(() => FeedbackModule), PlaybooksModule],
  providers: [LLMFeedbackService],
  exports: [LLMFeedbackService],
})
export class LLMFeedbackModule {}
