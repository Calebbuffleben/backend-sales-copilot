import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';

interface AudioChunk {
  meeting_id: string;
  participant_id: string;
  track: string;
  wav_data: Buffer;
  sample_rate: number;
  channels: number;
  timestamp_ms: number;
  sequence: number;
}

interface StreamAudioResponse {
  success: boolean;
  message: string;
  chunks_received: number;
}

interface GrpcStream {
  stream: grpc.ClientWritableStream<AudioChunk>;
  key: string;
  createdAt: number;
  lastUsedAt: number;
  sequence: number;
}

@Injectable()
export class GrpcAudioClient implements OnModuleDestroy {
  private readonly logger = new Logger(GrpcAudioClient.name);
  private client: any;
  private streams = new Map<string, GrpcStream>();
  private readonly serviceUrl: string;
  private readonly serviceUsesTls: boolean;
  private readonly enabled: boolean;
  private readonly streamTimeoutMs: number;

  constructor() {
    const defaultGrpcAudioUrl = 'https://text-analysis-production.up.railway.app';
    this.serviceUrl = process.env.GRPC_AUDIO_SERVICE_URL || defaultGrpcAudioUrl;
    this.enabled =
      (process.env.GRPC_AUDIO_SERVICE_ENABLED || 'true') === 'true';
    this.streamTimeoutMs = parseInt(
      process.env.GRPC_STREAM_TIMEOUT_MS || '30000',
      10,
    );

    if (this.enabled) {
      this.initializeClient();
      this.startStreamCleanup();
    } else {
      this.logger.warn('gRPC audio service is disabled');
    }
  }

  private initializeClient() {
    try {
      // Caminho relativo ao diretório raiz do projeto (funciona em dev e prod após build)
      const protoPath = join(process.cwd(), 'proto', 'audio_pipeline.proto');
      const packageDefinition = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const audioPipelineProto = grpc.loadPackageDefinition(
        packageDefinition,
      ) as any;

      this.client = new audioPipelineProto.audio_pipeline.AudioPipelineService(
        this.serviceUrl,
        grpc.credentials.createInsecure(),
      );

      this.logger.log(`gRPC client initialized for ${this.serviceUrl}`);
    } catch (error) {
      this.logger.error(
        `Failed to initialize gRPC client: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Cria ou retorna um stream existente para a chave especificada
   */
  getOrCreateStream(key: string): GrpcStream | null {
    if (!this.enabled || !this.client) {
      return null;
    }

    let grpcStream = this.streams.get(key);

    if (!grpcStream || this.isStreamClosed(grpcStream)) {
      const newStream = this.createStream(key);
      if (newStream) {
        grpcStream = newStream;
        this.streams.set(key, grpcStream);
      } else {
        return null;
      }
    } else {
      grpcStream.lastUsedAt = Date.now();
    }

    return grpcStream;
  }

  private createStream(key: string): GrpcStream | null {
    try {
      const stream = this.client.StreamAudio(
        (error: grpc.ServiceError | null, response: StreamAudioResponse) => {
          if (error) {
            this.logger.error(
              `gRPC stream error for ${key}: ${error.message}`,
              error.stack,
            );
          } else {
            this.logger.debug(
              `gRPC stream response for ${key}: ${JSON.stringify(response)}`,
            );
          }
        },
      );

      const grpcStream: GrpcStream = {
        stream,
        key,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sequence: 0,
      };

      stream.on('error', (error: Error) => {
        this.logger.error(`Stream error for ${key}: ${error.message}`);
        this.streams.delete(key);
      });

      stream.on('end', () => {
        this.logger.debug(`Stream ended for ${key}`);
        this.streams.delete(key);
      });

      this.logger.debug(`Created gRPC stream for ${key}`);
      return grpcStream;
    } catch (error) {
      this.logger.error(
        `Failed to create stream for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Envia um chunk de áudio através do stream
   */
  async sendAudioChunk(key: string, chunk: AudioChunk): Promise<void> {
    if (!this.enabled || !this.client) {
      this.logger.warn('gRPC client is disabled or not initialized');
      return;
    }

    const grpcStream = this.getOrCreateStream(key);
    if (!grpcStream) {
      throw new Error(`Failed to get or create stream for ${key}`);
    }

    grpcStream.sequence += 1;
    chunk.sequence = grpcStream.sequence;
    grpcStream.lastUsedAt = Date.now();

    return new Promise((resolve, reject) => {
      grpcStream.stream.write(chunk, (error: Error | null) => {
        if (error) {
          this.logger.error(
            `Failed to write chunk to stream ${key}: ${error.message}`,
          );
          this.streams.delete(key);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Fecha um stream específico
   */
  closeStream(key: string): void {
    const grpcStream = this.streams.get(key);
    if (grpcStream && !this.isStreamClosed(grpcStream)) {
      try {
        grpcStream.stream.end();
        this.logger.debug(`Closed gRPC stream for ${key}`);
      } catch (error) {
        this.logger.error(
          `Error closing stream for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.streams.delete(key);
  }

  /**
   * Verifica se o stream está fechado
   */
  private isStreamClosed(grpcStream: GrpcStream): boolean {
    return (
      grpcStream.stream.writableEnded ||
      grpcStream.stream.destroyed ||
      Date.now() - grpcStream.lastUsedAt > this.streamTimeoutMs
    );
  }

  /**
   * Limpa streams inativos periodicamente
   */
  private startStreamCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, stream] of this.streams.entries()) {
        if (now - stream.lastUsedAt > this.streamTimeoutMs) {
          this.logger.debug(
            `Cleaning up inactive stream for ${key} (timeout: ${this.streamTimeoutMs}ms)`,
          );
          this.closeStream(key);
        }
      }
    }, 10000); // Verifica a cada 10 segundos
  }

  /**
   * Fecha todos os streams ativos
   */
  onModuleDestroy() {
    this.logger.log('Closing all gRPC streams...');
    for (const key of this.streams.keys()) {
      this.closeStream(key);
    }
    if (this.client) {
      this.client.close();
    }
  }

  /**
   * Retorna estatísticas dos streams ativos
   */
  getStreamStats(): {
    totalStreams: number;
    streams: Array<{
      key: string;
      createdAt: number;
      lastUsedAt: number;
      sequence: number;
      age: number;
      idleTime: number;
    }>;
  } {
    const now = Date.now();
    return {
      totalStreams: this.streams.size,
      streams: Array.from(this.streams.values()).map((s) => ({
        key: s.key,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        sequence: s.sequence,
        age: now - s.createdAt,
        idleTime: now - s.lastUsedAt,
      })),
    };
  }
}
