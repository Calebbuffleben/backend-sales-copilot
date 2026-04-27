import { FeedbackSeverity, FeedbackType } from '@prisma/client';

export type ParticipantRole = 'host' | 'participant' | 'unknown';

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
  tenant_id?: string;
}

export interface LLMAnalysisIngress {
  directFeedback: string;
  conversationStateJson: string;
  samplesCount?: number;
  speechCount?: number;
  meanRmsDbfs?: number;
}

export interface LLMIngressEvent {
  tenantId: string;
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
  /** Optional redundant tenantId sent by the client. MUST equal tenantId from
   *  the token when present — checked by `FeedbackGrpcServer` before this
   *  event reaches any service. */
  claimedTenantId?: string;
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
  tenantId: string,
): LLMIngressEvent {
  return {
    tenantId,
    claimedTenantId: request.tenant_id?.trim() || undefined,
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
