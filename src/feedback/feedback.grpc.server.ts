import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';

import { logFeedbackTrace, makeFeedbackTraceId } from './feedback-trace';
import { mapPublishFeedbackRequest } from './feedback.mapper';
import { LLMFeedbackService } from '../llm-feedback/llm-feedback.service';

type UnaryCallback<T> = (error: grpc.ServiceError | null, response?: T) => void;

interface PublishFeedbackResponse {
  accepted: boolean;
  feedback_id: string;
  message: string;
}

@Injectable()
export class FeedbackGrpcServer {
  constructor(
    private readonly llmFeedbackService: LLMFeedbackService,
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
      const windowEndMs = ingressEvent.windowEnd.getTime();
      const traceId = makeFeedbackTraceId(
        ingressEvent.meetingId,
        ingressEvent.participantId,
        windowEndMs,
      );

      // We just call the LLMFeedbackService
      console.log(`[Step 7] Recebido payload do LLM via gRPC no backend para reunião ${ingressEvent.meetingId}`);
      await this.llmFeedbackService.handleIngress(ingressEvent);

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
        hasDirectFeedback: !!ingressEvent.analysis.directFeedback,
        handleMs: tIngressEndMs - tIngressStartMs,
        windowEndToBackendMs,
      });

      callback(null, {
        accepted: true,
        feedback_id: '',
        message: 'Accepted LLM feedback event',
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
