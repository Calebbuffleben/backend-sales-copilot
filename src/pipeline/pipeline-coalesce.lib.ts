/** Default passthrough batch: ~12 desktop frames @ 20ms (640 B each @ 16 kHz mono). */
export const DEFAULT_COALESCE_MS = 250;
export const MIN_COALESCE_MS = 20;
export const MAX_COALESCE_MS = 2000;

export type CoalesceMeta = {
  /** Per-stream override in milliseconds. */
  coalesceMs?: number;
  /** Legacy per-stream override in seconds (converted to ms). */
  groupSeconds?: number;
};

export function clampCoalesceMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_COALESCE_MS;
  }
  return Math.min(MAX_COALESCE_MS, Math.max(MIN_COALESCE_MS, Math.floor(ms)));
}

export function loadDefaultCoalesceMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawMs = env.AUDIO_PIPELINE_COALESCE_MS;
  if (rawMs !== undefined && rawMs.trim() !== '') {
    return clampCoalesceMs(Number(rawMs));
  }

  const rawSec = env.AUDIO_PIPELINE_GROUP_SECONDS;
  if (rawSec !== undefined && rawSec.trim() !== '') {
    const seconds = Number(rawSec);
    if (Number.isFinite(seconds) && seconds > 0) {
      return clampCoalesceMs(seconds * 1000);
    }
  }

  return DEFAULT_COALESCE_MS;
}

export function resolveCoalesceMs(
  defaultMs: number,
  meta?: CoalesceMeta,
): number {
  if (meta?.coalesceMs && meta.coalesceMs > 0) {
    return clampCoalesceMs(meta.coalesceMs);
  }
  if (meta?.groupSeconds && meta.groupSeconds > 0) {
    return clampCoalesceMs(meta.groupSeconds * 1000);
  }
  return clampCoalesceMs(defaultMs);
}

export function computeCoalesceThresholdBytes(
  sampleRate: number,
  channels: number,
  coalesceMs: number,
): number {
  const bytesPerSamplePerChannel = 2; // s16le
  return Math.floor(
    sampleRate * bytesPerSamplePerChannel * channels * (coalesceMs / 1000),
  );
}

export function shouldFlushCoalescedBatch(
  bytesAccumulated: number,
  thresholdBytes: number,
  batchStartedAt: number,
  coalesceMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (bytesAccumulated <= 0) return false;
  if (bytesAccumulated >= thresholdBytes) return true;
  return nowMs - batchStartedAt >= coalesceMs;
}
