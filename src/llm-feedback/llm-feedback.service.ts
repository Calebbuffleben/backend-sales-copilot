import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { LLMIngressEvent } from '../feedback/feedback.mapper';
import { FeedbackService } from '../feedback/feedback.service';

@Injectable()
export class LLMFeedbackService {
  private readonly logger = new Logger(LLMFeedbackService.name);

  constructor(
    @Inject(forwardRef(() => FeedbackService))
    private readonly feedbackService: FeedbackService
  ) {}

  async handleIngress(event: LLMIngressEvent): Promise<void> {
    if (!event.analysis.directFeedback) {
      // Nenhum feedback direto foi gerado pela LLM para esse trecho
      return;
    }

    try {
      this.logger.log(`Emitindo e salvando LLM Feedback para sala ${event.meetingId}`);

      // Passa a bola para o FeedbackService que orquestra a persistencia DB
      // e consequentemente emite o broadcast de WebSockets via Gateway
      await this.feedbackService.createFeedback({
        meetingId: event.meetingId,
        participantId: event.participantId,
        type: 'llm_insight' as any,
        severity: 'info' as any,
        ts: event.timestamp,
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        message: event.analysis.directFeedback,
        metadata: {
          conversationStateJson: event.analysis.conversationStateJson,
        },
      });
    } catch (error) {
      this.logger.error(`Error emitting LLM feedback: ${error}`);
    }
  }
}
