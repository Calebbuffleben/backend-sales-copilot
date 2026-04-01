import { FeedbackSeverity, FeedbackType } from '@prisma/client';
import { createHash } from 'crypto';

import type {
  FeedbackEventPayload,
  FeedbackRuleContext,
  MeetingFeedbackState,
  TextAnalysisIngressEvent,
} from '../text-analysis-feedback/types';
import { inCooldown, roundNumber, setCooldown } from '../text-analysis-feedback/utils';
import {
  isFeedbackTraceDebug,
  logFeedbackTrace,
  makeFeedbackTraceId,
} from '../feedback-trace';

const FEEDBACK_TYPE = FeedbackType.conversation_dominance;
const FEEDBACK_SEVERITY = FeedbackSeverity.warning;

const LOOKBACK_MS_DEFAULT = 60_000;
const THRESHOLD_DEFAULT = 0.7;
const MIN_MEETING_SPEECH_COUNT_DEFAULT = 12_000;
const COOLDOWN_MS_DEFAULT = 120_000;

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function makeDeterministicEventId(params: {
  meetingId: string;
  participantId: string;
  feedbackType: FeedbackType;
  severity: FeedbackSeverity;
  windowEndMs: number;
}): string {
  const raw = `${params.meetingId}|${params.participantId}|${params.feedbackType}|${params.severity}|${params.windowEndMs}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function detectConversationDominance(
  meetingState: MeetingFeedbackState,
  event: TextAnalysisIngressEvent,
  nowMs: number,
  _ctx: FeedbackRuleContext,
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
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'missing_participant_state',
      });
    }
    return null;
  }

  const lookbackMs = Math.max(
    1_000,
    readNumberEnv('SALES_CONVERSATION_DOMINANCE_LOOKBACK_MS', LOOKBACK_MS_DEFAULT),
  );
  const threshold = Math.min(
    0.95,
    Math.max(
      0.5,
      readNumberEnv('SALES_CONVERSATION_DOMINANCE_THRESHOLD', THRESHOLD_DEFAULT),
    ),
  );
  const minMeetingSpeechCount = Math.max(
    1,
    readNumberEnv(
      'SALES_CONVERSATION_DOMINANCE_MIN_MEETING_SPEECH_COUNT',
      MIN_MEETING_SPEECH_COUNT_DEFAULT,
    ),
  );
  const cooldownMs = Math.max(
    0,
    readNumberEnv('SALES_CONVERSATION_DOMINANCE_COOLDOWN_MS', COOLDOWN_MS_DEFAULT),
  );

  if (cooldownMs > 0 && inCooldown(participantState, FEEDBACK_TYPE, nowMs)) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'cooldown',
        cooldownMs,
      });
    }
    return null;
  }

  const startMs = nowMs - lookbackMs;
  const recentSamples = meetingState.samples.filter(
    (sample) => sample.timestampMs >= startMs && sample.timestampMs <= nowMs,
  );

  if (recentSamples.length === 0) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'no_samples',
        lookbackMs,
      });
    }
    return null;
  }

  const speechByParticipant = new Map<string, number>();
  let meetingSpeechCount = 0;

  for (const sample of recentSamples) {
    const participantSpeech = sample.speechCount ?? 0;
    meetingSpeechCount += participantSpeech;
    speechByParticipant.set(
      sample.participantId,
      (speechByParticipant.get(sample.participantId) ?? 0) + participantSpeech,
    );
  }

  if (meetingSpeechCount < minMeetingSpeechCount) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'low_meeting_speech',
        meetingSpeechCount,
        minMeetingSpeechCount,
      });
    }
    return null;
  }

  let dominantParticipantId: string | null = null;
  let dominantSpeechCount = 0;
  for (const [participantId, speechCount] of speechByParticipant.entries()) {
    if (speechCount > dominantSpeechCount) {
      dominantParticipantId = participantId;
      dominantSpeechCount = speechCount;
    }
  }

  if (!dominantParticipantId || dominantParticipantId !== event.participantId) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'not_dominant_participant',
        dominantParticipantId,
      });
    }
    return null;
  }

  const speechShare = dominantSpeechCount / Math.max(meetingSpeechCount, 1);
  if (speechShare < threshold) {
    if (isFeedbackTraceDebug()) {
      logFeedbackTrace('backend.detector', {
        traceId,
        meetingId: event.meetingId,
        participantId: event.participantId,
        windowEndMs: event.windowEnd.getTime(),
        detector: 'conversation_dominance',
        outcome: 'suppress',
        reason: 'below_threshold',
        speechShare: roundNumber(speechShare, 3),
        threshold,
      });
    }
    return null;
  }

  if (cooldownMs > 0) {
    setCooldown(participantState, FEEDBACK_TYPE, nowMs, cooldownMs);
  }

  const normalizedGap = Math.max(0, (speechShare - threshold) / (1 - threshold));
  const confidence = roundNumber(Math.min(1, threshold + normalizedGap * 0.3), 2);
  const deterministicEventId = makeDeterministicEventId({
    meetingId: event.meetingId,
    participantId: event.participantId,
    feedbackType: FEEDBACK_TYPE,
    severity: FEEDBACK_SEVERITY,
    windowEndMs: nowMs,
  });

  logFeedbackTrace('backend.detector', {
    traceId,
    meetingId: event.meetingId,
    participantId: event.participantId,
    windowEndMs: event.windowEnd.getTime(),
    detector: 'conversation_dominance',
    outcome: 'emit',
    confidence,
    speechShare: roundNumber(speechShare, 3),
    threshold,
    meetingSpeechCount,
    participantSpeechCount: dominantSpeechCount,
    ruleMatches: {
      participantIsDominant: true,
      thresholdReached: true,
    },
  });

  return {
    meetingId: event.meetingId,
    participantId: event.participantId,
    type: FEEDBACK_TYPE,
    severity: FEEDBACK_SEVERITY,
    ts: new Date(nowMs),
    window: {
      start: new Date(startMs),
      end: new Date(nowMs),
    },
    message: 'Voce esta falando mais que o restante da conversa',
    metadata: {
      feedbackTraceId: traceId,
      eventId: deterministicEventId,
      confidence,
      speechShare: roundNumber(speechShare, 3),
      participantSpeechCount: dominantSpeechCount,
      meetingSpeechCount,
      lookbackMs,
      threshold,
      minMeetingSpeechCount,
      cooldownMs,
      ruleMatches: {
        participantIsDominant: true,
        thresholdReached: true,
      },
      window: {
        start: new Date(startMs).toISOString(),
        end: new Date(nowMs).toISOString(),
      },
    },
  };
}
