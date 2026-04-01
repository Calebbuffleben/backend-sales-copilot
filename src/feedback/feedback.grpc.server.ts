import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';

import { logFeedbackTrace, makeFeedbackTraceId } from './feedback-trace';
import { mapPublishFeedbackRequest } from './feedback.mapper';
import { TextAnalysisFeedbackService } from './text-analysis-feedback/text-analysis-feedback.service';

type UnaryCallback<T> = (error: grpc.ServiceError | null, response?: T) => void;

interface PublishFeedbackResponse {
  accepted: boolean;
  feedback_id: string;
  message: string;
}

@Injectable()
export class FeedbackGrpcServer {
  constructor(
    private readonly textAnalysisFeedbackService: TextAnalysisFeedbackService,
  ) {}

  getImplementation() {
    return {
      PublishFeedback: this.publishFeedback.bind(this),
    };
  }

  async publishFeedback(
    call: { request: Parameters<typeof mapPublishFeedbackRequest>[0] },
    callback: UnaryCallback<PublishFeedbackResponse>,
  ) {
    try {
      const tIngressStartMs = Date.now();
      const ingressEvent = mapPublishFeedbackRequest(call.request);
      const indecisionMetrics = ingressEvent.analysis.indecisionMetrics;
      const windowEndMs = ingressEvent.windowEnd.getTime();
      const traceId = makeFeedbackTraceId(
        ingressEvent.meetingId,
        ingressEvent.participantId,
        windowEndMs,
      );
      const flagsTrue: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(ingressEvent.analysis.categoryFlags)) {
        if (v) {
          flagsTrue[k] = true;
        }
      }

      const feedbacks =
        await this.textAnalysisFeedbackService.handleIngress(ingressEvent);
      const firstFeedback = feedbacks[0];
      const tIngressEndMs = Date.now();
      const windowEndToBackendMs =
        Number.isFinite(windowEndMs) && windowEndMs > 0
          ? tIngressEndMs - windowEndMs
          : null;

      logFeedbackTrace('backend.ingress', {
        traceId,
        meetingId: ingressEvent.meetingId,
        participantId: ingressEvent.participantId,
        windowEndMs,
        transcriptChars: ingressEvent.text.length,
        salesCategory: ingressEvent.analysis.salesCategory ?? null,
        categoryIntensity: ingressEvent.analysis.categoryIntensity ?? null,
        flagsTrue:
          Object.keys(flagsTrue).length > 0 ? flagsTrue : undefined,
        indecisionCond: indecisionMetrics?.conditionalLanguageScore ?? null,
        indecisionPost: indecisionMetrics?.postponementLikelihood ?? null,
        handleMs: tIngressEndMs - tIngressStartMs,
        windowEndToBackendMs,
        feedbacksEmitted: feedbacks.length,
        firstFeedbackType: firstFeedback?.type ?? null,
      });

      callback(null, {
        accepted: true,
        feedback_id: firstFeedback?.id ?? '',
        message:
          feedbacks.length > 0
            ? `Accepted and emitted ${feedbacks.length} feedback event(s)`
            : 'Accepted analysis event without emitted feedback',
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown feedback error';
      console.error(`Failed to publish feedback via gRPC: ${message}`);

      callback({
        name: 'FeedbackPublishError',
        message,
        code: grpc.status.INTERNAL,
      } as grpc.ServiceError);
    }
  }
}
