import { Injectable, Logger } from '@nestjs/common';
import { GrpcAudioClient } from './grpc-audio.client';
import { convertPcmToWav } from './audio-utils';
import {
  computeCoalesceThresholdBytes,
  loadDefaultCoalesceMs,
  resolveCoalesceMs,
  shouldFlushCoalescedBatch,
} from './pipeline-coalesce.lib';

export type AudioChunkMeta = {
  tenantId: string;
  userId?: string;
  meetingId: string;
  participant: string;
  participantRole?: string;
  track: string;
  sampleRate: number; // Hz
  channels: number; // 1 or 2
  /** Passthrough batch size in ms (overrides service default). */
  coalesceMs?: number;
  /** Legacy per-call override in seconds (converted to ms). */
  groupSeconds?: number;
  sellerRoomId?: string;
  acousticClass?: string;
  matchedSellerId?: string;
  correlationConfidence?: number;
};

type BufferState = {
  buffers: Buffer[];
  bytesAccumulated: number;
  thresholdBytes: number;
  coalesceMs: number;
  batchStartedAt: number;
  seq: number;
};

@Injectable()
export class PipelineService {
  private keyToState = new Map<string, BufferState>();
  private readonly defaultCoalesceMs: number;
  private readonly logger = new Logger(PipelineService.name);

  constructor(private readonly grpcClient: GrpcAudioClient) {
    this.defaultCoalesceMs = loadDefaultCoalesceMs();
    this.logger.log(
      `Audio passthrough coalesce window: ${this.defaultCoalesceMs}ms (env AUDIO_PIPELINE_COALESCE_MS or legacy AUDIO_PIPELINE_GROUP_SECONDS)`,
    );
  }

  enqueueChunk(data: Buffer, meta: AudioChunkMeta) {
    const key = this.buildKey(meta);
    const coalesceMs = resolveCoalesceMs(this.defaultCoalesceMs, meta);
    const thresholdBytes = computeCoalesceThresholdBytes(
      meta.sampleRate,
      meta.channels,
      coalesceMs,
    );

    let state = this.keyToState.get(key);
    if (!state) {
      state = {
        buffers: [],
        bytesAccumulated: 0,
        thresholdBytes,
        coalesceMs,
        batchStartedAt: Date.now(),
        seq: 0,
      };
      this.keyToState.set(key, state);
    } else if (
      state.coalesceMs !== coalesceMs ||
      state.thresholdBytes !== thresholdBytes
    ) {
      state.coalesceMs = coalesceMs;
      state.thresholdBytes = thresholdBytes;
    }

    if (state.bytesAccumulated === 0) {
      state.batchStartedAt = Date.now();
    }

    state.buffers.push(data);
    state.bytesAccumulated += data.length;

    if (
      shouldFlushCoalescedBatch(
        state.bytesAccumulated,
        state.thresholdBytes,
        state.batchStartedAt,
        state.coalesceMs,
      )
    ) {
      this.flush(meta, key, state);
    }
  }

  private buildKey(meta: AudioChunkMeta): string {
    return `${meta.tenantId}:${meta.meetingId}:${meta.participant}:${meta.track}`;
  }

  private flush(meta: AudioChunkMeta, key: string, state: BufferState): void {
    if (state.bytesAccumulated === 0) {
      return;
    }
    const payload = Buffer.concat(state.buffers, state.bytesAccumulated);
    state.buffers = [];
    state.bytesAccumulated = 0;
    state.batchStartedAt = Date.now();
    state.seq += 1;

    const captureTs = Date.now();
    const seq = state.seq;

    this.dispatchToGrpc(meta, payload, captureTs, seq).catch((err) => {
      this.logger.error(
        `Dispatch error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async dispatchToGrpc(
    meta: AudioChunkMeta,
    pcm: Buffer,
    captureTs: number,
    seq: number,
  ): Promise<void> {
    const t1_received = Date.now();
    const key = this.buildKey(meta);

    try {
      const t2_conversion_start = Date.now();
      const wavBuffer = convertPcmToWav(pcm, meta.sampleRate, meta.channels);
      const t2_conversion_end = Date.now();

      const audioChunk = {
        meeting_id: meta.meetingId,
        participant_id: meta.participant,
        track: meta.track,
        wav_data: wavBuffer,
        sample_rate: meta.sampleRate,
        channels: meta.channels,
        timestamp_ms: captureTs,
        sequence: seq,
        tenant_id: meta.tenantId,
        user_id: meta.userId ?? '',
        participant_role: meta.participantRole ?? 'unknown',
        acoustic_class: meta.acousticClass ?? '',
        seller_room_id: meta.sellerRoomId ?? '',
        matched_seller_id: meta.matchedSellerId ?? '',
        correlation_confidence: meta.correlationConfidence ?? 0,
      };

      const t3_ready_to_send = Date.now();

      await this.grpcClient.sendAudioChunk(key, audioChunk);

      const t4_sent = Date.now();

      this.logger.debug(`[LATENCY] Audio pipeline timing`, {
        meetingId: meta.meetingId,
        participantId: meta.participant,
        seq,
        timestamps: {
          t0_capture: captureTs,
          t1_received: t1_received,
          t2_conversion_start: t2_conversion_start,
          t2_conversion_end: t2_conversion_end,
          t3_ready: t3_ready_to_send,
          t4_sent: t4_sent,
        },
        latencies_ms: {
          capture_to_received: t1_received - captureTs,
          received_to_conversion: t2_conversion_start - t1_received,
          conversion_time: t2_conversion_end - t2_conversion_start,
          conversion_to_ready: t3_ready_to_send - t2_conversion_end,
          ready_to_sent: t4_sent - t3_ready_to_send,
          total_backend: t4_sent - t1_received,
        },
        sizes: {
          pcm_bytes: pcm.length,
          wav_bytes: wavBuffer.length,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to dispatch audio chunk via gRPC for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
