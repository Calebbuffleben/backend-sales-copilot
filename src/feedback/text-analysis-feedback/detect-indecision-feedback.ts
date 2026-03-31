import { FeedbackSeverity, FeedbackType } from '@prisma/client';
import { createHash } from 'crypto';

import type {
  FeedbackEventPayload,
  FeedbackRuleContext,
  MeetingFeedbackState,
  TextAnalysisIngressEvent,
} from './types';
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
const MIN_FAST_TEXT_LENGTH = 20;
const FAST_CONDITIONAL_MIN = 0.72;
const FAST_POSTPONEMENT_MIN = 0.78;
const FAST_SUPPORTING_POSTPONEMENT_MIN = 0.45;
const SEMANTIC_PRIMARY_MIN_INTENSITY = 0.45;
const SEMANTIC_SUPPORTING_MIN_INTENSITY = 0.72;
const SEMANTIC_PERSISTENT_MIN_INTENSITY = 0.45;
const PRIMARY_SEMANTIC_CATEGORIES = new Set(['client_indecision']);
const SUPPORTING_SEMANTIC_CATEGORIES = new Set([
  'stalling',
  'conversation_stalling',
]);
const PRIMARY_SEMANTIC_FLAGS = ['client_indecision'] as const;
const SUPPORTING_SEMANTIC_FLAGS = [
  'stalling',
  'conversation_stalling',
] as const;
// Use console.* for tracing so logs are visible even when Nest logger is disabled.

function hasAnySemanticFlag(
  flags: Record<string, boolean> | undefined,
  keys: readonly string[],
): boolean {
  if (!flags) {
    return false;
  }

  return keys.some((key) => flags[key] === true);
}

function isSemanticCategory(
  category: string | undefined,
  categories: ReadonlySet<string>,
): boolean {
  return typeof category === 'string'
    ? categories.has(category)
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
  const participantState = meetingState.byParticipant[event.participantId];
  if (!participantState) {
    console.warn(
      `[detectClientIndecision] missing participantState participantId=${event.participantId}`,
    );
    return null;
  }

  const participantRole =
    ctx.getParticipantRole(event.meetingId, event.participantId) ??
    participantState.participantRole ??
    event.participantRole ??
    'unknown';
  if (participantRole === 'host') {
    console.log(
      `[detectClientIndecision] suppressed: participant is host participantId=${event.participantId}`,
    );
    return null;
  }

  const effectiveIndecisionCooldownMs = Number(
    process.env.SALES_CLIENT_INDECISION_COOLDOWN_MS ?? '120000',
  );
  if (
    effectiveIndecisionCooldownMs > 0 &&
    inCooldown(participantState, FEEDBACK_TYPE, nowMs)
  ) {
    console.log(
      `[detectClientIndecision] suppressed: cooldown active participantId=${event.participantId} cooldownMs=${effectiveIndecisionCooldownMs}`,
    );
    return null;
  }

  if (
    participantState.lastFeedbackText &&
    participantState.lastFeedbackTextAt &&
    nowMs - participantState.lastFeedbackTextAt < SAME_SEGMENT_WINDOW_MS &&
    textSimilar(participantState.lastFeedbackText, event.text, 0.6)
  ) {
    console.log(
      `[detectClientIndecision] suppressed: similar text within segment participantId=${event.participantId}`,
    );
    return null;
  }

  const trimmedText = event.text.trim();
  const signalValidity = event.analysis.signalValidity ?? {};
  const fastSignalValid = signalValidity['indecision_fast'] !== false;
  const semanticSignalValid = signalValidity['indecision_semantic'] !== false;
  if (!fastSignalValid) {
    console.log(
      `[detectClientIndecision] suppressed: indecision_fast invalid participantId=${event.participantId} level=${event.analysis.degradationLevel ?? 'n/a'} reasons=${event.analysis.suppressionReasons.join('|') || 'n/a'}`,
    );
    return null;
  }

  const indecisionMetrics = event.analysis.indecisionMetrics;
  const condScore = indecisionMetrics?.conditionalLanguageScore ?? 0;
  const postScore = indecisionMetrics?.postponementLikelihood ?? 0;
  const currentCategory = event.analysis.salesCategory;
  const currentIntensity = event.analysis.categoryIntensity ?? 0;
  const conditionalKeywordCount =
    event.analysis.conditionalKeywordsDetected.length;
  const currentPrimarySemanticCategory = isSemanticCategory(
    currentCategory,
    PRIMARY_SEMANTIC_CATEGORIES,
  );
  const currentSupportingSemanticCategory = isSemanticCategory(
    currentCategory,
    SUPPORTING_SEMANTIC_CATEGORIES,
  );
  const currentPrimarySemanticFlag = hasAnySemanticFlag(
    event.analysis.categoryFlags,
    PRIMARY_SEMANTIC_FLAGS,
  );
  const currentSupportingSemanticFlag = hasAnySemanticFlag(
    event.analysis.categoryFlags,
    SUPPORTING_SEMANTIC_FLAGS,
  );
  const recentTextHistory = participantState.textAnalysis.textHistory.filter(
    (entry) => entry.timestampMs >= nowMs - PERSISTENT_WINDOW_MS,
  );
  const previousRecentEntries = recentTextHistory.filter(
    (entry) => entry.timestampMs < nowMs,
  );
  const hasRecentPrimarySemanticIndecision = previousRecentEntries.some(
    (entry) =>
      (isSemanticCategory(entry.salesCategory, PRIMARY_SEMANTIC_CATEGORIES) ||
        hasAnySemanticFlag(entry.categoryFlags, PRIMARY_SEMANTIC_FLAGS)) &&
      (entry.categoryIntensity ?? 0) >= SEMANTIC_PERSISTENT_MIN_INTENSITY,
  );
  const hasRecentSupportingSemanticIndecision = previousRecentEntries.some(
    (entry) =>
      (isSemanticCategory(entry.salesCategory, SUPPORTING_SEMANTIC_CATEGORIES) ||
        hasAnySemanticFlag(entry.categoryFlags, SUPPORTING_SEMANTIC_FLAGS)) &&
      (entry.categoryIntensity ?? 0) >= SEMANTIC_SUPPORTING_MIN_INTENSITY,
  );

  const semanticStrongRule =
    semanticSignalValid &&
    (currentPrimarySemanticCategory || currentPrimarySemanticFlag) &&
    currentIntensity >= SEMANTIC_PRIMARY_MIN_INTENSITY;
  const semanticSupportingRule =
    semanticSignalValid &&
    (currentSupportingSemanticCategory || currentSupportingSemanticFlag) &&
    currentIntensity >= SEMANTIC_SUPPORTING_MIN_INTENSITY &&
    (condScore >= FAST_SUPPORTING_POSTPONEMENT_MIN ||
      postScore >= FAST_SUPPORTING_POSTPONEMENT_MIN ||
      hasRecentPrimarySemanticIndecision);
  const persistentRule =
    semanticSignalValid &&
    currentIntensity >= SEMANTIC_PERSISTENT_MIN_INTENSITY &&
    (
      (currentPrimarySemanticCategory || currentPrimarySemanticFlag) ||
      ((currentSupportingSemanticCategory || currentSupportingSemanticFlag) &&
        hasRecentPrimarySemanticIndecision)
    ) &&
    (hasRecentPrimarySemanticIndecision || hasRecentSupportingSemanticIndecision);
  const fastConservativeRule =
    trimmedText.length >= MIN_FAST_TEXT_LENGTH &&
    (
      postScore >= FAST_POSTPONEMENT_MIN ||
      (condScore >= FAST_CONDITIONAL_MIN &&
        postScore >= FAST_SUPPORTING_POSTPONEMENT_MIN) ||
      (condScore >= FAST_CONDITIONAL_MIN && conditionalKeywordCount >= 2)
    );

  const signalPath = semanticStrongRule || semanticSupportingRule || persistentRule
    ? 'semantic'
    : fastConservativeRule
      ? 'fast'
      : null;

  if (
    !semanticStrongRule &&
    !semanticSupportingRule &&
    !persistentRule &&
    !fastConservativeRule
  ) {
    console.log(
      `[detectClientIndecision] suppressed: low confidence participantId=${event.participantId} condScore=${condScore.toFixed(2)} postScore=${postScore.toFixed(2)} category=${currentCategory ?? 'n/a'} intensity=${currentIntensity.toFixed(2)} fastSignalValid=${fastSignalValid} semanticSignalValid=${semanticSignalValid} conditionalKeywords=${conditionalKeywordCount} hasRecentPrimary=${hasRecentPrimarySemanticIndecision} rules: semanticStrong=${semanticStrongRule} semanticSupporting=${semanticSupportingRule} persistent=${persistentRule} fastConservative=${fastConservativeRule}`,
    );
    return null;
  }

  let confidence = 0;
  if (semanticStrongRule) {
    confidence = Math.max(confidence, currentIntensity);
  }
  if (semanticSupportingRule) {
    confidence = Math.max(confidence, Math.max(currentIntensity, postScore));
  }
  if (persistentRule) {
    confidence = Math.max(confidence, Math.max(currentIntensity, 0.62));
  }
  if (fastConservativeRule) {
    confidence = Math.max(
      confidence,
      Math.min(0.82, Math.max(condScore, postScore)),
    );
  }

  console.log(
    `[detectClientIndecision] emitting participantId=${event.participantId} path=${signalPath ?? 'n/a'} condScore=${condScore.toFixed(2)} postScore=${postScore.toFixed(2)} category=${currentCategory ?? 'n/a'} intensity=${currentIntensity.toFixed(2)} confidence=${roundNumber(confidence, 2)} rules: semanticStrong=${semanticStrongRule} semanticSupporting=${semanticSupportingRule} persistent=${persistentRule} fastConservative=${fastConservativeRule}`,
  );

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
        semanticStrong: semanticStrongRule,
        semanticSupporting: semanticSupportingRule,
        persistentIndecision: persistentRule,
        fastConservative: fastConservativeRule,
      },
      signalPath,
      signalValidity: {
        indecisionFast: fastSignalValid,
        indecisionSemantic: semanticSignalValid,
      },
      window: {
        samplesCount: feedbackWindow.samplesCount,
        speechCount: feedbackWindow.speechCount,
        meanRmsDbfs: feedbackWindow.meanRmsDbfs,
      },
    },
  };
}
