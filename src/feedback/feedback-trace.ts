import { createHash } from 'crypto';

/** Same formula as python-service/src/feedback_trace.py */
export function makeFeedbackTraceId(
  meetingId: string,
  participantId: string,
  windowEndMs: number,
): string {
  const raw = `${meetingId}|${participantId}|${Math.trunc(windowEndMs)}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

export function isFeedbackTraceDebug(): boolean {
  const v = process.env.FEEDBACK_TRACE_DEBUG;
  return v === '1' || v === 'true' || v === 'yes';
}

export function logFeedbackTrace(
  stage: string,
  fields: Record<string, unknown>,
): void {
  const payload = { stage, ...fields };
  console.log(JSON.stringify(payload));
}
