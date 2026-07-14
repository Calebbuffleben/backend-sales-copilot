import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { FingerprintCacheService } from './fingerprint-cache';

export type WireFingerprint = {
  version: number;
  userId: string;
  sellerRoomId: string;
  meetingId: string;
  seq: number;
  windowDurationMs: number;
  captureMonoMs: number;
  captureServerMs?: number;
  energyDbfs: number;
  featureBytes: string; // base64 Int8
  featureType: string;
};

const MAX_PAYLOAD_BYTES = 2048;
const ALLOWED_FEATURE_TYPES = new Set(['logmel_mfcc_v1']);

@Injectable()
export class SellerAudioFingerprintService {
  private readonly pendingBatches = new Map<string, WireFingerprint[]>();

  constructor(private readonly cache: FingerprintCacheService) {}

  validateAndNormalize(
    fingerprint: unknown,
    expected: {
      expectedUserId: string;
      expectedRoomId: string;
      expectedMeetingId: string;
    },
  ): WireFingerprint {
    if (!fingerprint || typeof fingerprint !== 'object') {
      throw new BadRequestException('fingerprint required');
    }
    const fp = fingerprint as Record<string, unknown>;
    const version = Number(fp.version ?? 1);
    const userId = String(fp.userId ?? '');
    const sellerRoomId = String(fp.sellerRoomId ?? '');
    const meetingId = String(fp.meetingId ?? '');
    const seq = Number(fp.seq);
    const windowDurationMs = Number(fp.windowDurationMs ?? 200);
    const captureMonoMs = Number(fp.captureMonoMs ?? fp.captureTimeMs ?? 0);
    const energyDbfs = Number(fp.energyDbfs ?? -120);
    const featureType = String(fp.featureType ?? 'logmel_mfcc_v1');
    const featureBytes = String(fp.featureBytes ?? '');

    if (userId !== expected.expectedUserId) {
      throw new BadRequestException('fingerprint.userId must match JWT sub');
    }
    if (sellerRoomId !== expected.expectedRoomId) {
      throw new BadRequestException('fingerprint.sellerRoomId mismatch');
    }
    if (meetingId !== expected.expectedMeetingId) {
      throw new BadRequestException('fingerprint.meetingId mismatch');
    }
    if (!Number.isFinite(seq) || seq < 0) {
      throw new BadRequestException('invalid fingerprint.seq');
    }
    if (!ALLOWED_FEATURE_TYPES.has(featureType)) {
      throw new BadRequestException('unsupported featureType');
    }
    if (!featureBytes) {
      throw new BadRequestException('featureBytes required');
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(featureBytes, 'base64');
    } catch {
      throw new BadRequestException('featureBytes must be base64');
    }
    if (decoded.byteLength === 0 || decoded.byteLength > 256) {
      throw new BadRequestException('featureBytes size out of range');
    }
    const approxSize =
      featureBytes.length +
      userId.length +
      sellerRoomId.length +
      meetingId.length +
      80;
    if (approxSize > MAX_PAYLOAD_BYTES) {
      throw new BadRequestException('fingerprint payload too large');
    }

    return {
      version,
      userId,
      sellerRoomId,
      meetingId,
      seq,
      windowDurationMs,
      captureMonoMs,
      energyDbfs,
      featureBytes,
      featureType,
    };
  }

  async assertRedisReady(): Promise<void> {
    if (!this.cache.isRequired()) {
      // Dev single-replica: allow in-memory-only mode without Redis.
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException(
          'REDIS_URL required for Seller Rooms in production',
        );
      }
      return;
    }
    const ok = await this.cache.ensureConnected();
    if (!ok) {
      throw new ServiceUnavailableException('Fingerprint Redis unavailable');
    }
  }

  async checkMonotonicSeq(
    tenantId: string,
    roomId: string,
    userId: string,
    seq: number,
  ): Promise<boolean> {
    const last = await this.cache.getLastSeq(tenantId, roomId, userId);
    if (last >= 0 && seq <= last) {
      return false;
    }
    await this.cache.setLastSeq(tenantId, roomId, userId, seq);
    return true;
  }

  enqueueForCache(
    tenantId: string,
    roomId: string,
    userId: string,
    fingerprint: WireFingerprint,
  ): void {
    const key = `${tenantId}:${roomId}:${userId}`;
    const batch = this.pendingBatches.get(key) ?? [];
    batch.push(fingerprint);
    this.pendingBatches.set(key, batch);
    if (batch.length >= 5) {
      void this.flushBatch(tenantId, roomId, userId);
    }
  }

  async flushBatch(
    tenantId: string,
    roomId: string,
    userId: string,
  ): Promise<void> {
    const key = `${tenantId}:${roomId}:${userId}`;
    const batch = this.pendingBatches.get(key);
    if (!batch || batch.length === 0) return;
    this.pendingBatches.set(key, []);
    const payload = Buffer.from(
      JSON.stringify({
        seqRange: [batch[0].seq, batch[batch.length - 1].seq],
        captureServerMs: batch[batch.length - 1].captureServerMs,
        fingerprints: batch,
      }),
      'utf8',
    );
    await this.cache.setMicroBatch(tenantId, roomId, userId, payload, 3);
  }

  async snapshot(
    tenantId: string,
    roomId: string,
    userIds: string[],
  ): Promise<Record<string, WireFingerprint[]>> {
    const raw = await this.cache.getSnapshot(tenantId, roomId, userIds);
    const out: Record<string, WireFingerprint[]> = {};
    for (const [userId, b64] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(
          Buffer.from(b64, 'base64').toString('utf8'),
        ) as { fingerprints?: WireFingerprint[] };
        out[userId] = parsed.fingerprints ?? [];
      } catch {
        out[userId] = [];
      }
    }
    return out;
  }
}
