/** Lightweight acoustic label buffer for egress → gRPC parity with Python PCM v2. */

export type AcousticClass = 'seller' | 'customer' | 'unknown';

export type AcousticWindowLabel = {
  labelId: number;
  acousticClass: AcousticClass;
  matchedSellerId?: string;
  confidence: number;
  windowStartMs: number;
  windowEndMs: number;
};

function normalizeClass(value: unknown): AcousticClass {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v === 'seller' || v === 'customer' || v === 'unknown') return v;
  return 'unknown';
}

export function parseAcousticLabelControl(
  raw: string,
): AcousticWindowLabel | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj.type !== 'acoustic_label') return null;
    return {
      labelId: Number(obj.labelId ?? obj.label_id ?? 0),
      acousticClass: normalizeClass(obj.acousticClass ?? obj.acoustic_class),
      matchedSellerId: obj.matchedSellerId
        ? String(obj.matchedSellerId)
        : obj.matched_seller_id
          ? String(obj.matched_seller_id)
          : undefined,
      confidence: Number(obj.confidence ?? 0),
      windowStartMs: Number(obj.windowStartMs ?? obj.window_start_ms ?? 0),
      windowEndMs: Number(obj.windowEndMs ?? obj.window_end_ms ?? 0),
    };
  } catch {
    return null;
  }
}

export function aggregateTurnAcousticClass(
  labels: AcousticWindowLabel[],
  startMs: number,
  endMs: number,
): AcousticClass {
  let sellerScore = 0;
  let customerScore = 0;
  let total = 0;
  for (const label of labels) {
    const overlap =
      Math.min(endMs, label.windowEndMs) - Math.max(startMs, label.windowStartMs);
    if (overlap <= 0) continue;
    const weight = overlap * Math.max(0.1, label.confidence);
    total += weight;
    if (label.acousticClass === 'seller') sellerScore += weight;
    else if (label.acousticClass === 'customer') customerScore += weight;
  }
  if (total <= 0) return 'unknown';
  const s = sellerScore / total;
  const c = customerScore / total;
  if (s >= 0.65 && s - c >= 0.15) return 'seller';
  if (c >= 0.75 && s <= 0.2) return 'customer';
  return 'unknown';
}

export class AcousticLabelBuffer {
  private labels: AcousticWindowLabel[] = [];
  private byId = new Map<number, AcousticWindowLabel>();
  private current: AcousticWindowLabel | null = null;
  private readonly maxLabels: number;

  constructor(maxLabels = 200) {
    this.maxLabels = maxLabels;
  }

  upsert(label: AcousticWindowLabel): void {
    this.byId.set(label.labelId, label);
    this.current = label;
    this.labels.push(label);
    while (this.labels.length > this.maxLabels) {
      const old = this.labels.shift();
      if (old && this.byId.get(old.labelId) === old) {
        this.byId.delete(old.labelId);
      }
    }
  }

  resolve(labelId: number): AcousticWindowLabel | null {
    return this.byId.get(labelId) ?? this.current;
  }

  currentClass(): AcousticClass {
    return this.current?.acousticClass ?? 'unknown';
  }

  aggregate(startMs: number, endMs: number): AcousticClass {
    const aggregated = aggregateTurnAcousticClass(this.labels, startMs, endMs);
    if (aggregated !== 'unknown') return aggregated;
    return this.currentClass();
  }

  snapshot(): AcousticWindowLabel[] {
    return [...this.labels];
  }
}

/** PCM v2 magic 0x4D503206 — returns { pcm, labelId } or null if not v2. */
export function stripPcmV2(
  buffer: Buffer,
): { pcm: Buffer; labelId: number } | null {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x4d503206) {
    return null;
  }
  const labelId = buffer.readUInt32BE(12);
  const pcmLength = buffer.readUInt32BE(16);
  if (buffer.length < 24 + pcmLength) return null;
  return {
    pcm: buffer.subarray(24, 24 + pcmLength),
    labelId,
  };
}
