import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { FeedbackService } from '../feedback.service';
import { mapFeedbackEventPayloadToFeedbackPayload } from '../feedback.mapper';
import { ParticipantContextProvider } from './context-provider';
import { isFeedbackTraceDebug, logFeedbackTrace, makeFeedbackTraceId } from '../feedback-trace';
import { buildTextAnalysisDetectors } from './detectors';
import { MeetingStateStore } from './state-store';
import type {
  FeedbackEventPayload,
  TextAnalysisDetector,
  TextAnalysisIngressEvent,
} from './types';

type PersistedFeedbackEvent = Prisma.FeedbackEventGetPayload<
  Record<string, never>
>;

@Injectable()
export class TextAnalysisFeedbackService {
  private readonly detectors: TextAnalysisDetector[] =
    buildTextAnalysisDetectors();

  constructor(
    private readonly meetingStateStore: MeetingStateStore,
    private readonly participantContextProvider: ParticipantContextProvider,
    private readonly feedbackService: FeedbackService,
  ) {}

  async handleIngress(
    event: TextAnalysisIngressEvent,
  ): Promise<PersistedFeedbackEvent[]> {
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
    if (isFeedbackTraceDebug()) {
      const traceId = makeFeedbackTraceId(
        event.meetingId,
        event.participantId,
        event.windowEnd.getTime(),
      );
      logFeedbackTrace('backend.detectorBatch', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detectorCount: this.detectors.length,
      });
    }
    const payloads = this.detectors
      .map((detector) =>
        detector(meetingState, event, nowMs, this.participantContextProvider),
      )
      .filter((payload): payload is FeedbackEventPayload => Boolean(payload));

    const persistedFeedbacks: PersistedFeedbackEvent[] = [];
    for (const payload of payloads) {
      const feedbackPayload = mapFeedbackEventPayloadToFeedbackPayload(payload);
      persistedFeedbacks.push(
        await this.feedbackService.createFeedback(feedbackPayload),
      );
    }

    return persistedFeedbacks;
  }
}
