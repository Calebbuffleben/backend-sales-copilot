import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FeedbackService } from '../feedback.service';
import { mapFeedbackEventPayloadToFeedbackPayload } from '../feedback.mapper';
import { ParticipantContextProvider } from './context-provider';
import { buildTextAnalysisDetectors } from './detectors';
import { MeetingStateStore } from './state-store';
import type {
  FeedbackEventPayload,
  TextAnalysisDetectorDefinition,
  TextAnalysisIngressEvent,
} from './types';

type PersistedFeedbackEvent = Prisma.FeedbackEventGetPayload<
  Record<string, never>
>;

@Injectable()
export class TextAnalysisFeedbackService {
  private readonly detectors: TextAnalysisDetectorDefinition[] =
    buildTextAnalysisDetectors();

  constructor(
    private readonly meetingStateStore: MeetingStateStore,
    private readonly participantContextProvider: ParticipantContextProvider,
    private readonly feedbackService: FeedbackService,
  ) {}

  async handleIngress(
    event: TextAnalysisIngressEvent,
  ): Promise<PersistedFeedbackEvent[]> {
    console.log(
      `[TextAnalysisFeedbackService] handleIngress meetingId=${event.meetingId} participantId=${event.participantId} ts=${event.timestamp.toISOString()} textChars=${event.text.length} salesCategory=${event.analysis.salesCategory ?? 'n/a'} indecisionMetrics=${JSON.stringify(event.analysis.indecisionMetrics ?? {})}`,
    );

    const meetingState = this.meetingStateStore.recordIngress(event);
    this.participantContextProvider.recordParticipantMetadata(
      event.meetingId,
      event.participantId,
      {
        participantName: event.participantName,
        participantRole: event.participantRole,
      },
    );

    const nowMs = event.timestamp.getTime();
    const eligibleDetectors = this.detectors.filter((detector) => {
      const requiredSignals = detector.requiredSignals ?? [];
      if (requiredSignals.length === 0) {
        return true;
      }

      const missingSignals = requiredSignals.filter(
        (signal) => event.analysis.signalValidity[signal] === false,
      );
      if (missingSignals.length === 0) {
        return true;
      }

      console.log(
        `[TextAnalysisFeedbackService] detector suppressed_by_quality name=${detector.name} signals=${missingSignals.join(',')} mode=${event.analysis.analysisMode ?? 'n/a'} level=${event.analysis.degradationLevel ?? 'n/a'} reasons=${event.analysis.suppressionReasons.join('|') || 'n/a'}`,
      );
      return false;
    });
    console.log(
      `[TextAnalysisFeedbackService] running detectors count=${eligibleDetectors.length} total=${this.detectors.length} mode=${event.analysis.analysisMode ?? 'n/a'} level=${event.analysis.degradationLevel ?? 'n/a'}`,
    );
    const payloads = eligibleDetectors
      .map((detector) =>
        detector.run(
          meetingState,
          event,
          nowMs,
          this.participantContextProvider,
        ),
      )
      .filter((payload): payload is FeedbackEventPayload => Boolean(payload));

    const persistedFeedbacks: PersistedFeedbackEvent[] = [];
    for (const payload of payloads) {
      console.log(
        `[TextAnalysisFeedbackService] detector matched type=${payload.type} severity=${payload.severity} message=${payload.message} confidence=${payload.metadata && typeof payload.metadata === 'object' ? payload.metadata['confidence'] : 'n/a'}`,
      );
      const feedbackPayload = mapFeedbackEventPayloadToFeedbackPayload(payload);
      persistedFeedbacks.push(
        await this.feedbackService.createFeedback(feedbackPayload),
      );
    }

    console.log(
      `[TextAnalysisFeedbackService] persistedFeedbacks=${persistedFeedbacks.length}`,
    );
    return persistedFeedbacks;
  }
}
