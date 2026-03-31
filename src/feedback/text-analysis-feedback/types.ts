import type { FeedbackSeverity, FeedbackType } from '@prisma/client';

export type ParticipantRole = 'host' | 'participant' | 'unknown';

export interface IngressIndecisionMetrics {
  conditionalLanguageScore?: number;
  postponementLikelihood?: number;
}

export interface TextAnalysisIngress {
  embedding: number[];
  keywords: string[];
  speechAct?: string;
  salesCategory?: string;
  salesCategoryConfidence?: number;
  categoryIntensity?: number;
  categoryAmbiguity?: number;
  categoryFlags: Record<string, boolean>;
  conditionalKeywordsDetected: string[];
  indecisionMetrics?: IngressIndecisionMetrics;
  samplesCount?: number;
  speechCount?: number;
  meanRmsDbfs?: number;
  analysisMode?: string;
  degradationLevel?: string;
  signalValidity: Record<string, boolean>;
  suppressionReasons: string[];
}

export interface TextAnalysisIngressEvent {
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
  analysis: TextAnalysisIngress;
}

export interface TextHistoryEntry {
  text: string;
  timestampMs: number;
  salesCategory?: string;
  salesCategoryConfidence?: number;
  categoryIntensity?: number;
  categoryFlags: Record<string, boolean>;
  speechAct?: string;
  indecisionMetrics?: IngressIndecisionMetrics;
  conditionalKeywordsDetected: string[];
}

export interface MeetingSampleEntry {
  participantId: string;
  timestampMs: number;
  samplesCount: number;
  speechCount: number;
  meanRmsDbfs?: number;
}

export interface ParticipantFeedbackState {
  participantId: string;
  participantName?: string;
  participantRole?: ParticipantRole;
  textAnalysis: {
    textHistory: TextHistoryEntry[];
  };
  cooldowns: Record<string, number>;
  lastFeedbackText?: string;
  lastFeedbackTextAt?: number;
}

export interface MeetingFeedbackState {
  meetingId: string;
  byParticipant: Record<string, ParticipantFeedbackState>;
  samples: MeetingSampleEntry[];
}

export interface FeedbackRuleContext {
  getParticipantRole(
    meetingId: string,
    participantId: string,
  ): ParticipantRole | null;
  getParticipantName(meetingId: string, participantId: string): string | null;
  recordParticipantMetadata(
    meetingId: string,
    participantId: string,
    data: {
      participantName?: string;
      participantRole?: ParticipantRole;
    },
  ): void;
}

export interface FeedbackEventPayload {
  meetingId: string;
  participantId: string;
  type: FeedbackType;
  severity: FeedbackSeverity;
  ts: Date;
  window: {
    start: Date;
    end: Date;
  };
  message: string;
  metadata: Record<string, unknown>;
}

export type TextAnalysisDetector = (
  meetingState: MeetingFeedbackState,
  event: TextAnalysisIngressEvent,
  nowMs: number,
  ctx: FeedbackRuleContext,
) => FeedbackEventPayload | null;

export interface TextAnalysisDetectorDefinition {
  name: string;
  requiredSignals?: readonly string[];
  run: TextAnalysisDetector;
}
