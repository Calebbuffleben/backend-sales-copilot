import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';

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
      const ingressEvent = mapPublishFeedbackRequest(call.request);
      const indecisionMetrics = ingressEvent.analysis.indecisionMetrics;

      console.log(
        `[grpc->backend] PublishFeedback meetingId=${ingressEvent.meetingId} participantId=${ingressEvent.participantId} ts=${ingressEvent.timestamp.toISOString()} transcriptChars=${ingressEvent.text.length} indecision={cond:${indecisionMetrics?.conditionalLanguageScore ?? 0} post:${indecisionMetrics?.postponementLikelihood ?? 0}} salesCategory=${ingressEvent.analysis.salesCategory ?? 'n/a'}`,
      );

      const feedbacks =
        await this.textAnalysisFeedbackService.handleIngress(ingressEvent);
      const firstFeedback = feedbacks[0];

      console.log(
        `[backend] detect/mapping produced feedbacks=${feedbacks.length}${firstFeedback ? ` firstType=${firstFeedback.type}` : ''}`,
      );

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
