import { FeedbackSeverity, FeedbackType } from '@prisma/client';

import type { FeedbackPayload } from './feedback.service';
import type { ParticipantRole } from './text-analysis-feedback/types';

export interface ProtoAnalysisPayload {
  direct_feedback?: string;
  conversation_state_json?: string;
  samples_count?: number;
  speech_count?: number;
  mean_rms_dbfs?: number;
}

export interface PublishFeedbackRequest {
  meeting_id: string;
  participant_id: string;
  participant_name?: string;
  participant_role?: string;
  feedback_type: string;
  severity: string;
  ts_ms: number | string;
  window_start_ms: number | string;
  window_end_ms: number | string;
  message: string;
  transcript_text?: string;
  transcript_confidence?: number;
  analysis?: ProtoAnalysisPayload;
}

export interface LLMAnalysisIngress {
  directFeedback: string;
  conversationStateJson: string;
  samplesCount?: number;
  speechCount?: number;
  meanRmsDbfs?: number;
}

export interface LLMIngressEvent {
  meetingId: string;
  participantId: string;
  participantName?: string;
  participantRole?: ParticipantRole;
  timestamp: Date;
  windowStart: Date;
  windowEnd: Date;
  text: string;
  confidence: number;
  rawFeedbackType?: string;
  rawSeverity?: string;
  rawMessage?: string;
  analysis: LLMAnalysisIngress;
}

function toDateFromEpochMs(value: number | string): Date {
  const parsedValue = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Invalid timestamp value: ${value}`);
  }
  return new Date(parsedValue);
}

function toParticipantRole(value?: string): ParticipantRole | undefined {
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (
    normalizedValue === 'host' ||
    normalizedValue === 'participant' ||
    normalizedValue === 'unknown'
  ) {
    return normalizedValue as ParticipantRole;
  }

  return undefined;
}

export function mapPublishFeedbackRequest(
  request: PublishFeedbackRequest,
): LLMIngressEvent {
  return {
    meetingId: request.meeting_id,
    participantId: request.participant_id,
    participantName: request.participant_name?.trim() || undefined,
    participantRole: toParticipantRole(request.participant_role),
    timestamp: toDateFromEpochMs(request.ts_ms),
    windowStart: toDateFromEpochMs(request.window_start_ms),
    windowEnd: toDateFromEpochMs(request.window_end_ms),
    text: request.transcript_text?.trim() || '',
    confidence: request.transcript_confidence ?? 0,
    rawFeedbackType: request.feedback_type,
    rawSeverity: request.severity,
    rawMessage: request.message,
    analysis: {
      directFeedback: request.analysis?.direct_feedback || '',
      conversationStateJson: request.analysis?.conversation_state_json || '{}',
      samplesCount: request.analysis?.samples_count,
      speechCount: request.analysis?.speech_count,
      meanRmsDbfs: request.analysis?.mean_rms_dbfs,
    },
  };
}
