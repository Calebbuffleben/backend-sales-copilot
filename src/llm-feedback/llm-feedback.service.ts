import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { LLMIngressEvent } from '../feedback/feedback.mapper';
import { FeedbackService } from '../feedback/feedback.service';

@Injectable()
export class LLMFeedbackService {
  private readonly logger = new Logger(LLMFeedbackService.name);

  constructor(
    @Inject(forwardRef(() => FeedbackService))
    private readonly feedbackService: FeedbackService,
  ) {}

  async handleIngress(event: LLMIngressEvent): Promise<void> {
    if (!event.analysis.directFeedback) {
      // Nenhum feedback direto foi gerado pela LLM para esse trecho
      this.logger.log(
        `[Step 8] O evento recebido (Reunião ${event.meetingId}) não possui feedback direto da LLM, ignorando propagação para UI.`,
      );
      return;
    }

    try {
      this.logger.log(
        `[Step 8] Processando feedback positivo da LLM para persistência/UI: "${event.analysis.directFeedback}"`,
      );

      let severity: 'info' | 'warning' | 'critical' = 'info';
      let spinPhase: string | undefined;
      let spinRisk: boolean | undefined;
      try {
        const raw = event.analysis.conversationStateJson;
        if (raw && raw !== '{}') {
          const cs = JSON.parse(raw) as Record<string, unknown>;
          if (cs && typeof cs === 'object') {
            if (cs.alerta_risco_spin === true) {
              severity = 'warning';
            }
            if (typeof cs.fase_spin === 'string') {
              spinPhase = cs.fase_spin;
            }
            if (typeof cs.alerta_risco_spin === 'boolean') {
              spinRisk = cs.alerta_risco_spin;
            }
          }
        }
      } catch {
        // ignore malformed JSON; keep defaults
      }

      // Passa a bola para o FeedbackService que orquestra a persistencia DB
      // e consequentemente emite o broadcast de WebSockets via Gateway
      await this.feedbackService.createFeedback({
        tenantId: event.tenantId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        type: 'llm_insight' as any,
        severity: severity as any,
        ts: event.timestamp,
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        message: event.analysis.directFeedback,
        metadata: {
          conversationStateJson: event.analysis.conversationStateJson,
          ...(spinPhase !== undefined ? { spinPhase } : {}),
          ...(spinRisk !== undefined ? { spinRisk } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Error emitting LLM feedback: ${error}`);
    }
  }
}
