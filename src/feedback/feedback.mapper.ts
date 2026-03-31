import { FeedbackSeverity, FeedbackType } from '@prisma/client';

import type { FeedbackPayload } from './feedback.service';
import type {
  FeedbackEventPayload,
  IngressIndecisionMetrics,
  ParticipantRole,
  TextAnalysisIngressEvent,
} from './text-analysis-feedback/types';

export interface ProtoIndecisionMetrics {
  conditional_language_score?: number;
  postponement_likelihood?: number;
}

export interface ProtoAnalysisPayload {
  embedding?: number[];
  keywords?: string[];
  speech_act?: string;
  sales_category?: string;
  sales_category_confidence?: number;
  category_intensity?: number;
  category_ambiguity?: number;
  category_flags?: Record<string, boolean>;
  conditional_keywords_detected?: string[];
  indecision_metrics?: ProtoIndecisionMetrics;
  samples_count?: number;
  speech_count?: number;
  mean_rms_dbfs?: number;
  analysis_mode?: string;
  degradation_level?: string;
  signal_validity?: Record<string, boolean>;
  suppression_reasons?: string[];
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

function toDateFromEpochMs(value: number | string): Date {
  const parsedValue = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Invalid timestamp value: ${value}`);
  }
  return new Date(parsedValue);
}

function toFeedbackType(value: string): FeedbackType {
  if ((Object.values(FeedbackType) as string[]).includes(value)) {
    return value as FeedbackType;
  }
  throw new Error(`Unsupported feedback type: ${value}`);
}

function toFeedbackSeverity(value: string): FeedbackSeverity {
  if ((Object.values(FeedbackSeverity) as string[]).includes(value)) {
    return value as FeedbackSeverity;
  }
  throw new Error(`Unsupported feedback severity: ${value}`);
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

function compactObject<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined || entry === null) {
        return false;
      }
      if (Array.isArray(entry)) {
        return entry.length > 0;
      }
      if (typeof entry === 'object') {
        return Object.keys(entry as Record<string, unknown>).length > 0;
      }
      if (typeof entry === 'string') {
        return entry.trim().length > 0;
      }
      return true;
    }),
  ) as Partial<T>;
}

function mapAnalysisMetadata(
  analysis?: ProtoAnalysisPayload,
): Record<string, unknown> | undefined {
  if (!analysis) {
    return undefined;
  }

  const indecisionMetrics = analysis.indecision_metrics
    ? compactObject({
        conditionalLanguageScore:
          analysis.indecision_metrics.conditional_language_score,
        postponementLikelihood:
          analysis.indecision_metrics.postponement_likelihood,
      })
    : undefined;

  return compactObject({
    embedding: analysis.embedding || [],
    keywords: analysis.keywords || [],
    salesCategory: analysis.sales_category,
    salesCategoryConfidence: analysis.sales_category_confidence,
    categoryIntensity: analysis.category_intensity,
    categoryAmbiguity: analysis.category_ambiguity,
    categoryFlags: analysis.category_flags || {},
    conditionalKeywordsDetected: analysis.conditional_keywords_detected || [],
    indecisionMetrics,
    analysisMode: analysis.analysis_mode,
    degradationLevel: analysis.degradation_level,
    signalValidity: analysis.signal_validity || {},
    suppressionReasons: analysis.suppression_reasons || [],
  });
}

function mapProtoIndecisionMetrics(
  metrics?: ProtoIndecisionMetrics,
): IngressIndecisionMetrics | undefined {
  if (!metrics) {
    return undefined;
  }

  return compactObject({
    conditionalLanguageScore: metrics.conditional_language_score,
    postponementLikelihood: metrics.postponement_likelihood,
  });
}

export function mapPublishFeedbackRequest(
  request: PublishFeedbackRequest,
): TextAnalysisIngressEvent {
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
      embedding: request.analysis?.embedding || [],
      keywords: request.analysis?.keywords || [],
      speechAct: request.analysis?.speech_act,
      salesCategory: request.analysis?.sales_category,
      salesCategoryConfidence: request.analysis?.sales_category_confidence,
      categoryIntensity: request.analysis?.category_intensity,
      categoryAmbiguity: request.analysis?.category_ambiguity,
      categoryFlags: request.analysis?.category_flags || {},
      conditionalKeywordsDetected:
        request.analysis?.conditional_keywords_detected || [],
      indecisionMetrics: mapProtoIndecisionMetrics(
        request.analysis?.indecision_metrics,
      ),
      samplesCount: request.analysis?.samples_count,
      speechCount: request.analysis?.speech_count,
      meanRmsDbfs: request.analysis?.mean_rms_dbfs,
      analysisMode: request.analysis?.analysis_mode,
      degradationLevel: request.analysis?.degradation_level,
      signalValidity: request.analysis?.signal_validity || {},
      suppressionReasons: request.analysis?.suppression_reasons || [],
    },
  };
}

export function mapFeedbackEventPayloadToFeedbackPayload(
  event: FeedbackEventPayload,
): FeedbackPayload {
  return {
    meetingId: event.meetingId,
    participantId: event.participantId,
    type: toFeedbackType(event.type),
    severity: toFeedbackSeverity(event.severity),
    ts: event.ts,
    windowStart: event.window.start,
    windowEnd: event.window.end,
    message: event.message,
    metadata: compactObject(event.metadata),
  };
}
