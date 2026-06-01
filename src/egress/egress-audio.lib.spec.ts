import { parseParticipantRole } from './egress-audio.lib';

describe('egress-audio.lib', () => {
  describe('parseParticipantRole', () => {
    it('accepts host, participant, and unknown', () => {
      expect(parseParticipantRole('host')).toBe('host');
      expect(parseParticipantRole('PARTICIPANT')).toBe('participant');
      expect(parseParticipantRole(' unknown ')).toBe('unknown');
    });

    it('returns unknown for missing or invalid values', () => {
      expect(parseParticipantRole(undefined)).toBe('unknown');
      expect(parseParticipantRole(null)).toBe('unknown');
      expect(parseParticipantRole('')).toBe('unknown');
      expect(parseParticipantRole('organizer')).toBe('unknown');
    });
  });
});
