import type { MeetingFeedbackState, ParticipantFeedbackState } from './types';

export function inCooldown(
  participantState: ParticipantFeedbackState,
  feedbackType: string,
  nowMs: number,
): boolean {
  const untilMs = participantState.cooldowns[feedbackType];
  return typeof untilMs === 'number' && untilMs > nowMs;
}

export function setCooldown(
  participantState: ParticipantFeedbackState,
  feedbackType: string,
  nowMs: number,
  cooldownMs: number,
): void {
  participantState.cooldowns[feedbackType] = nowMs + cooldownMs;
}

export function textSimilar(
  left: string,
  right: string,
  threshold: number,
): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftWords = new Set(normalizedLeft.split(' '));
  const rightWords = new Set(normalizedRight.split(' '));
  const intersectionSize = [...leftWords].filter((word) =>
    rightWords.has(word),
  ).length;
  const unionSize = new Set([...leftWords, ...rightWords]).size;
  return unionSize > 0 && intersectionSize / unionSize >= threshold;
}

export function extractRepresentativePhrases(
  participantState: ParticipantFeedbackState,
  recentChunks: number,
  maxPhrases: number,
  minConfidence: number,
): string[] {
  const entries = participantState.textAnalysis.textHistory
    .slice(-recentChunks)
    .filter((entry) => {
      const category = entry.salesCategory;
      const confidence = entry.salesCategoryConfidence ?? 0;
      const flags = entry.categoryFlags;
      return (
        Boolean(entry.text?.trim()) &&
        confidence >= minConfidence &&
        (category === 'client_indecision' ||
          category === 'stalling' ||
          category === 'conversation_stalling' ||
          flags.client_indecision === true ||
          flags.stalling === true ||
          flags.conversation_stalling === true)
      );
    })
    .sort(
      (left, right) =>
        (right.salesCategoryConfidence ?? 0) -
        (left.salesCategoryConfidence ?? 0),
    )
    .slice(0, maxPhrases)
    .map((entry) => truncateText(entry.text, 180));

  return Array.from(new Set(entries));
}

export function window(
  meetingState: MeetingFeedbackState,
  participantId: string,
  nowMs: number,
  lookbackMs: number,
): {
  start: Date;
  end: Date;
  samplesCount: number;
  speechCount: number;
  meanRmsDbfs: number | null;
} {
  const startMs = nowMs - lookbackMs;
  const recentSamples = meetingState.samples.filter(
    (sample) =>
      sample.participantId === participantId && sample.timestampMs >= startMs,
  );

  const samplesCount = recentSamples.reduce(
    (total, sample) => total + sample.samplesCount,
    0,
  );
  const speechCount = recentSamples.reduce(
    (total, sample) => total + sample.speechCount,
    0,
  );
  const dbfsValues = recentSamples
    .map((sample) => sample.meanRmsDbfs)
    .filter((value): value is number => typeof value === 'number');

  return {
    start: new Date(startMs),
    end: new Date(nowMs),
    samplesCount,
    speechCount,
    meanRmsDbfs:
      dbfsValues.length > 0
        ? roundNumber(
            dbfsValues.reduce((total, value) => total + value, 0) /
              dbfsValues.length,
            2,
          )
        : null,
  };
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

export function roundNumber(value: number, fractionDigits: number): number {
  return Number(value.toFixed(fractionDigits));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
