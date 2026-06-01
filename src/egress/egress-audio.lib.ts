export type ParticipantRole = 'host' | 'participant' | 'unknown';

const ALLOWED: ReadonlySet<ParticipantRole> = new Set([
  'host',
  'participant',
  'unknown',
]);

/** Normalize WS query `participantRole`; invalid/missing → `unknown`. */
export function parseParticipantRole(raw?: string | null): ParticipantRole {
  const normalized = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (ALLOWED.has(normalized as ParticipantRole)) {
    return normalized as ParticipantRole;
  }
  return 'unknown';
}
