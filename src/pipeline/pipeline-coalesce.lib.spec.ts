import {
  clampCoalesceMs,
  computeCoalesceThresholdBytes,
  DEFAULT_COALESCE_MS,
  loadDefaultCoalesceMs,
  resolveCoalesceMs,
  shouldFlushCoalescedBatch,
} from './pipeline-coalesce.lib';

describe('pipeline-coalesce.lib', () => {
  describe('loadDefaultCoalesceMs', () => {
    it('prefers AUDIO_PIPELINE_COALESCE_MS over GROUP_SECONDS', () => {
      expect(
        loadDefaultCoalesceMs({
          AUDIO_PIPELINE_COALESCE_MS: '250',
          AUDIO_PIPELINE_GROUP_SECONDS: '5',
        }),
      ).toBe(250);
    });

    it('falls back to GROUP_SECONDS when COALESCE_MS is unset', () => {
      expect(
        loadDefaultCoalesceMs({
          AUDIO_PIPELINE_GROUP_SECONDS: '0.5',
        }),
      ).toBe(500);
    });

    it('defaults to 250ms when env is empty', () => {
      expect(loadDefaultCoalesceMs({})).toBe(DEFAULT_COALESCE_MS);
    });
  });

  describe('computeCoalesceThresholdBytes', () => {
    it('maps 250ms at 16kHz mono to 8000 bytes', () => {
      expect(computeCoalesceThresholdBytes(16000, 1, 250)).toBe(8000);
    });
  });

  describe('shouldFlushCoalescedBatch', () => {
    const threshold = 8000;

    it('flushes when byte threshold is reached', () => {
      expect(
        shouldFlushCoalescedBatch(8000, threshold, 1000, 250, 1100),
      ).toBe(true);
    });

    it('flushes after coalesce window even with partial audio', () => {
      expect(
        shouldFlushCoalescedBatch(640, threshold, 1000, 250, 1250),
      ).toBe(true);
    });

    it('does not flush before coalesce window on small batches', () => {
      expect(
        shouldFlushCoalescedBatch(640, threshold, 1000, 250, 1200),
      ).toBe(false);
    });
  });

  describe('resolveCoalesceMs', () => {
    it('honors per-stream coalesceMs override', () => {
      expect(resolveCoalesceMs(250, { coalesceMs: 100 })).toBe(100);
    });

    it('converts legacy groupSeconds override', () => {
      expect(resolveCoalesceMs(250, { groupSeconds: 0.25 })).toBe(250);
    });
  });

  describe('clampCoalesceMs', () => {
    it('clamps below minimum to 20ms', () => {
      expect(clampCoalesceMs(5)).toBe(20);
    });
  });
});
