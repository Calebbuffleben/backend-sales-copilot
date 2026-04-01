import { Injectable, Logger } from '@nestjs/common';
import { GrpcAudioClient } from './grpc-audio.client';
import { convertPcmToWav } from './audio-utils';

export type AudioChunkMeta = {
  meetingId: string;
  participant: string;
  track: string;
  sampleRate: number; // Hz
  channels: number; // 1 or 2
  groupSeconds?: number; // optional per-call override
};

type BufferState = {
  buffers: Buffer[];
  bytesAccumulated: number;
  thresholdBytes: number;
  lastFlushAt: number;
  firstChunkAt: number;
  seq: number;
};

@Injectable()
export class PipelineService {
  private keyToState = new Map<string, BufferState>();
  private readonly defaultGroupSeconds: number;
  private readonly logger = new Logger(PipelineService.name);

  constructor(private readonly grpcClient: GrpcAudioClient) {
    const seconds = Number(process.env.AUDIO_PIPELINE_GROUP_SECONDS || '2');
    this.defaultGroupSeconds =
      Number.isFinite(seconds) && seconds > 0 ? seconds : 2;
  }

  enqueueChunk(data: Buffer, meta: AudioChunkMeta) {
    const key = this.buildKey(meta);
    const groupSeconds =
      meta.groupSeconds && meta.groupSeconds > 0
        ? meta.groupSeconds
        : this.defaultGroupSeconds;
    const thresholdBytes = this.computeThresholdBytes(meta, groupSeconds);
    let state = this.keyToState.get(key);
    if (!state) {
      state = {
        buffers: [],
        bytesAccumulated: 0,
        thresholdBytes,
        lastFlushAt: Date.now(),
        firstChunkAt: Date.now(),
        seq: 0,
      };
      this.keyToState.set(key, state);
    }

    state.buffers.push(data);
    state.bytesAccumulated += data.length;
    if (state.buffers.length === 1) {
      state.firstChunkAt = Date.now();
    }

    const timeSinceLastFlush = Date.now() - state.lastFlushAt;
    const timeTriggerMs = Math.max(
      500,
      (meta.groupSeconds && meta.groupSeconds > 0
        ? meta.groupSeconds
        : this.defaultGroupSeconds) * 1000,
    );
    if (
      state.bytesAccumulated >= state.thresholdBytes ||
      timeSinceLastFlush >= timeTriggerMs
    ) {
      this.flush(meta, key, state);
    }
  }

  private buildKey(meta: AudioChunkMeta): string {
    return `${meta.meetingId}:${meta.participant}:${meta.track}`;
  }

  private computeThresholdBytes(meta: AudioChunkMeta, seconds: number): number {
    const bytesPerSamplePerChannel = 2; // s16le
    return Math.floor(
      meta.sampleRate * bytesPerSamplePerChannel * meta.channels * seconds,
    );
  }

  // Transforma o buffer acumulado em um buffer de payload
  private flush(meta: AudioChunkMeta, key: string, state: BufferState): void {
    if (state.bytesAccumulated === 0) {
      return;
    }
    const payload = Buffer.concat(state.buffers, state.bytesAccumulated);
    state.buffers = [];
    state.bytesAccumulated = 0;
    state.lastFlushAt = Date.now();
    state.seq += 1;

    const captureTs = state.lastFlushAt; // coarse; will be refined to end-of-window timestamp
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
      // Converter PCM para WAV
      const t2_conversion_start = Date.now();
      const wavBuffer = convertPcmToWav(pcm, meta.sampleRate, meta.channels);
      const t2_conversion_end = Date.now();

      // Preparar chunk para envio via gRPC
      const audioChunk = {
        meeting_id: meta.meetingId,
        participant_id: meta.participant,
        track: meta.track,
        wav_data: wavBuffer,
        sample_rate: meta.sampleRate,
        channels: meta.channels,
        timestamp_ms: captureTs,
        sequence: seq,
      };

      const t3_ready_to_send = Date.now();

      // Enviar via gRPC client streaming
      await this.grpcClient.sendAudioChunk(key, audioChunk);

      const t4_sent = Date.now();

      // Latência detalhada (habilitar LOG_LEVEL=debug para ver no deploy)
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
