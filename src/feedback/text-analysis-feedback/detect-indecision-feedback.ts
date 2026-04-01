import { FeedbackSeverity, FeedbackType } from '@prisma/client';
import { createHash } from 'crypto';

import type {
  FeedbackEventPayload,
  FeedbackRuleContext,
  MeetingFeedbackState,
  TextAnalysisIngressEvent,
} from './types';
import {
  isFeedbackTraceDebug,
  logFeedbackTrace,
  makeFeedbackTraceId,
} from '../feedback-trace';
import {
  extractRepresentativePhrases,
  inCooldown,
  roundNumber,
  setCooldown,
  textSimilar,
  truncateText,
  window,
} from './utils';

const FEEDBACK_TYPE = FeedbackType.sales_client_indecision;
const FEEDBACK_SEVERITY = FeedbackSeverity.warning;
const SAME_SEGMENT_WINDOW_MS = 60_000;
const PERSISTENT_WINDOW_MS = 20_000;
const FEEDBACK_WINDOW_MS = 60_000;
const SEMANTIC_INDECISION_CATEGORIES = new Set([
  'client_indecision',
  'stalling',
  'conversation_stalling',
]);
const SEMANTIC_INDECISION_FLAGS = [
  'client_indecision',
  'stalling',
  'conversation_stalling',
] as const;
// Use console.* for tracing so logs are visible even when Nest logger is disabled.

function hasSemanticIndecisionFlag(
  flags: Record<string, boolean> | undefined,
): boolean {
  if (!flags) {
    return false;
  }

  return SEMANTIC_INDECISION_FLAGS.some((key) => flags[key] === true);
}

function isSemanticIndecisionCategory(category?: string): boolean {
  return typeof category === 'string'
    ? SEMANTIC_INDECISION_CATEGORIES.has(category)
    : false;
}

function makeDeterministicEventId(params: {
  meetingId: string;
  participantId: string;
  feedbackType: FeedbackType;
  severity: FeedbackSeverity;
  windowEndMs: number;
}): string {
  // Deterministic, stable identity for idempotency & debugging across retries.
  // Keep it short to reduce log/payload noise.
  const raw = `${params.meetingId}|${params.participantId}|${params.feedbackType}|${params.severity}|${params.windowEndMs}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function detectClientIndecision(
  meetingState: MeetingFeedbackState,
  event: TextAnalysisIngressEvent,
  nowMs: number,
  ctx: FeedbackRuleContext,
): FeedbackEventPayload | null {
  const traceId = makeFeedbackTraceId(
    event.meetingId,
    event.participantId,
    event.windowEnd.getTime(),
  );
  const participantState = meetingState.byParticipant[event.participantId];
  if (!participantState) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'sales_client_indecision',
        outcome: 'suppress',
        reason: 'missing_participant_state',
      });
    }
    return null;
  }

  const participantRole =
    ctx.getParticipantRole(event.meetingId, event.participantId) ??
    participantState.participantRole ??
    event.participantRole ??
    'unknown';
  if (participantRole === 'host') {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'sales_client_indecision',
        outcome: 'suppress',
        reason: 'host',
      });
    }
    return null;
  }

  const effectiveIndecisionCooldownMs = Number(
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS ?? '120000',
  );
  if (
    effectiveIndecisionCooldownMs > 0 &&
    inCooldown(participantState, FEEDBACK_TYPE, nowMs)
  ) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'sales_client_indecision',
        outcome: 'suppress',
        reason: 'cooldown',
        cooldownMs: effectiveIndecisionCooldownMs,
      });
    }
    return null;
  }

  if (
    participantState.lastFeedbackText &&
    participantState.lastFeedbackTextAt &&
    nowMs - participantState.lastFeedbackTextAt < SAME_SEGMENT_WINDOW_MS &&
    textSimilar(participantState.lastFeedbackText, event.text, 0.6)
  ) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'sales_client_indecision',
        outcome: 'suppress',
        reason: 'similar_segment',
      });
    }
    return null;
  }

  const indecisionMetrics = event.analysis.indecisionMetrics;
  const condScore = indecisionMetrics?.conditionalLanguageScore ?? 0;
  const postScore = indecisionMetrics?.postponementLikelihood ?? 0;
  const currentCategory = event.analysis.salesCategory;
  const currentIntensity = event.analysis.categoryIntensity ?? 0;
  const currentSemanticCategory = isSemanticIndecisionCategory(currentCategory);
  const currentSemanticFlag = hasSemanticIndecisionFlag(
    event.analysis.categoryFlags,
  );
  const recentTextHistory = participantState.textAnalysis.textHistory.filter(
    (entry) => entry.timestampMs >= nowMs - PERSISTENT_WINDOW_MS,
  );
  const previousRecentEntries = recentTextHistory.filter(
    (entry) => entry.timestampMs < nowMs,
  );
  const hasRecentSemanticIndecision = previousRecentEntries.some(
    (entry) =>
      (isSemanticIndecisionCategory(entry.salesCategory) ||
        hasSemanticIndecisionFlag(entry.categoryFlags)) &&
      (entry.categoryIntensity ?? 0) >= 0.4,
  );
  const currentSemanticQualifies =
    (currentSemanticCategory || currentSemanticFlag) && currentIntensity >= 0.4;

  const conditionalRule = condScore > 0.6;
  const postponementRule = postScore > 0.6;
  const semanticCategoryRule = currentSemanticQualifies;
  const persistentRule = currentSemanticQualifies && hasRecentSemanticIndecision;

  if (
    !conditionalRule &&
    !postponementRule &&
    !semanticCategoryRule &&
    !persistentRule
  ) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'sales_client_indecision',
        outcome: 'suppress',
        reason: 'no_rule_match',
        condScore: roundNumber(condScore, 3),
        postScore: roundNumber(postScore, 3),
        category: currentCategory ?? null,
        intensity: roundNumber(currentIntensity, 3),
        semanticFlag: currentSemanticFlag,
        hasRecentSemanticIndecision,
        ruleMatches: {
          conditionalLanguage: conditionalRule,
          postponement: postponementRule,
          semanticCategory: semanticCategoryRule,
          persistentIndecision: persistentRule,
        },
      });
    }
    return null;
  }

  const confidence = Math.max(
    conditionalRule ? condScore : 0,
    postponementRule ? postScore : 0,
    semanticCategoryRule ? currentIntensity : 0,
    persistentRule ? Math.max(currentIntensity, 0.45) : 0,
  );

  logFeedbackTrace('backend.detector', {
    traceId,
    meetingId: event.meetingId,
    participantId: event.participantId,
    windowEndMs: event.windowEnd.getTime(),
    detector: 'sales_client_indecision',
    outcome: 'emit',
    condScore: roundNumber(condScore, 3),
    postScore: roundNumber(postScore, 3),
    category: currentCategory ?? null,
    intensity: roundNumber(currentIntensity, 3),
    semanticFlag: currentSemanticFlag,
    hasRecentSemanticIndecision,
    confidence: roundNumber(confidence, 2),
    ruleMatches: {
      conditionalLanguage: conditionalRule,
      postponement: postponementRule,
      semanticCategory: semanticCategoryRule,
      persistentIndecision: persistentRule,
    },
  });

  const representativePhrases = extractRepresentativePhrases(
    participantState,
    5,
    5,
    0.15,
  );
  const fallbackPhrase = truncateText(event.text, 180);
  const feedbackWindow = window(
    meetingState,
    event.participantId,
    nowMs,
    FEEDBACK_WINDOW_MS,
  );

  if (effectiveIndecisionCooldownMs > 0) {
    setCooldown(
      participantState,
      FEEDBACK_TYPE,
      nowMs,
      effectiveIndecisionCooldownMs,
    );
  }

  participantState.lastFeedbackText = event.text;
  participantState.lastFeedbackTextAt = nowMs;

  const participantName =
    ctx.getParticipantName(event.meetingId, event.participantId) ??
    participantState.participantName ??
    event.participantName;

  const deterministicEventId = makeDeterministicEventId({
    meetingId: event.meetingId,
    participantId: event.participantId,
    feedbackType: FEEDBACK_TYPE,
    severity: FEEDBACK_SEVERITY,
    windowEndMs: nowMs,
  });

  return {
    meetingId: event.meetingId,
    participantId: event.participantId,
    type: FEEDBACK_TYPE,
    severity: FEEDBACK_SEVERITY,
    ts: new Date(nowMs),
    window: {
      start: feedbackWindow.start,
      end: feedbackWindow.end,
    },
    message: 'Cliente demonstrando indecisão',
    metadata: {
      feedbackTraceId: traceId,
      eventId: deterministicEventId,
      confidence: roundNumber(confidence, 2),
      representativePhrases:
        representativePhrases.length > 0
          ? representativePhrases
          : [fallbackPhrase],
      salesCategory: currentCategory,
      salesCategoryConfidence: event.analysis.salesCategoryConfidence,
      indecisionMetrics,
      conditionalKeywordsDetected: event.analysis.conditionalKeywordsDetected,
      participantName,
      tips: ['Pergunte o que está travando', 'Proponha próximo passo concreto'],
      ruleMatches: {
        conditionalLanguage: conditionalRule,
        postponement: postponementRule,
        semanticCategory: semanticCategoryRule,
        persistentIndecision: persistentRule,
      },
      window: {
        samplesCount: feedbackWindow.samplesCount,
        speechCount: feedbackWindow.speechCount,
        meanRmsDbfs: feedbackWindow.meanRmsDbfs,
      },
    },
  };
}
