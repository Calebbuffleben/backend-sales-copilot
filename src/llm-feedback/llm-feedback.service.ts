import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { LLMIngressEvent } from '../feedback/feedback.mapper';
import { FeedbackService } from '../feedback/feedback.service';
import { PlaybookResolverService } from '../playbooks/playbook-resolver.service';
import type { FeedbackPlaybookMetadata } from '../playbooks/playbook-metadata.contract';

@Injectable()
export class LLMFeedbackService {
  private readonly logger = new Logger(LLMFeedbackService.name);

  constructor(
    @Inject(forwardRef(() => FeedbackService))
    private readonly feedbackService: FeedbackService,
    private readonly playbookResolver: PlaybookResolverService,
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
      let feedbackTier: string | undefined;
      let parentTurnId: string | undefined;
      let specialist: Record<string, unknown> | undefined;
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
            if (cs._feedbackTier === 'secondary') {
              feedbackTier = 'secondary';
            }
            if (typeof cs._parentTurnId === 'string') {
              parentTurnId = cs._parentTurnId;
            }
            if (
              cs._specialist &&
              typeof cs._specialist === 'object' &&
              !Array.isArray(cs._specialist)
            ) {
              specialist = cs._specialist as Record<string, unknown>;
            }
          }
        }
      } catch {
        // ignore malformed JSON; keep defaults
      }

      let playbook: FeedbackPlaybookMetadata | undefined;
      const playbooksEnabled = process.env.PLAYBOOKS_ENABLED === 'true';
      if (playbooksEnabled) {
        try {
          playbook = await this.playbookResolver.resolve({
            tenantId: event.tenantId,
            playbookHintJson: event.analysis.playbookHintJson,
          });
        } catch (resolveErr) {
          this.logger.warn(
            `Playbook resolve failed (continuing without playbook): ${resolveErr instanceof Error ? resolveErr.message : resolveErr}`,
          );
          playbook = undefined;
        }
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
          ...(event.participantRole ? { participantRole: event.participantRole } : {}),
          ...(spinPhase !== undefined ? { spinPhase } : {}),
          ...(spinRisk !== undefined ? { spinRisk } : {}),
          ...(feedbackTier ? { tier: feedbackTier } : {}),
          ...(parentTurnId ? { parentTurnId } : {}),
          ...(specialist ? { specialist } : {}),
          ...(playbook ? { playbook } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Error emitting LLM feedback: ${error}`);
    }
  }
}
