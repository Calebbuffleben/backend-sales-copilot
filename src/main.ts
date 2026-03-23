import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EgressAudioGateway } from './egress/egress-audio.gateway';
import { FeedbackGrpcServer } from './feedback/feedback.grpc.server';
import * as dotenv from 'dotenv';
import { join, resolve } from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import dns from 'dns/promises';

function parseGrpcAudioHostname(): string | null {
  const raw = process.env.GRPC_AUDIO_SERVICE_URL?.trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname;
    } catch {
      return null;
    }
  }
  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0) {
    return raw.slice(0, lastColon);
  }
  return raw;
}

// Load environment variables from .env file (fallback to env file if .env doesn't exist)
dotenv.config({ path: resolve(process.cwd(), '.env') });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(process.cwd(), 'env') });
}

async function bootstrap() {
  // logger: false silencia TODO o Nest Logger (incl. EgressAudioGateway / PipelineService).
  // Prisma e console.log continuam — por isso só aparecia prisma:query + [bootstrap].
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Configure CORS for Chrome extension
  app.enableCors({
    origin: true, // Allow all origins (Chrome extensions can come from any origin)
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = process.env.PORT ?? 3001;
  const httpServer = await app.listen(port);

  // Get HTTP server and pass to EgressAudioGateway
  const egressGateway = app.get(EgressAudioGateway);
  egressGateway.setHttpServer(httpServer);

  const feedbackGrpcServer = app.get(FeedbackGrpcServer);
  const feedbackGrpcPort = Number(process.env.GRPC_FEEDBACK_PORT ?? '50052');
  const feedbackProtoPath = join(
    process.cwd(),
    'proto',
    'feedback_ingestion.proto',
  );
  const packageDefinition = protoLoader.loadSync(feedbackProtoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const feedbackProto = grpc.loadPackageDefinition(
    packageDefinition,
  ) as unknown as {
    feedback_ingestion: {
      FeedbackIngestionService: {
        service: grpc.ServiceDefinition<grpc.UntypedServiceImplementation>;
      };
    };
  };

  const grpcServer = new grpc.Server();
  grpcServer.addService(
    feedbackProto.feedback_ingestion.FeedbackIngestionService.service,
    feedbackGrpcServer.getImplementation(),
  );

  await new Promise<void>((resolvePromise, rejectPromise) => {
    grpcServer.bindAsync(
      `0.0.0.0:${feedbackGrpcPort}`,
      grpc.ServerCredentials.createInsecure(),
      (error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      },
    );
  });

  // Always visible in Railway (Prisma queries alone do not prove audio/gRPC path is active)
  // eslint-disable-next-line no-console
  console.log(
    '[bootstrap] ready | PORT=%s | GRPC_FEEDBACK_INGRESS=0.0.0.0:%s | GRPC_AUDIO_SERVICE_URL=%s | GRPC_AUDIO_USE_TLS=%s',
    port,
    feedbackGrpcPort,
    process.env.GRPC_AUDIO_SERVICE_URL || '(default from GrpcAudioClient)',
    process.env.GRPC_AUDIO_USE_TLS ?? '(infer)',
  );

  const grpcHost = parseGrpcAudioHostname();
  if (grpcHost && /\.railway\.internal$/i.test(grpcHost)) {
    try {
      const { address } = await dns.lookup(grpcHost);
      // eslint-disable-next-line no-console
      console.log(
        `[bootstrap] GRPC_AUDIO DNS OK | ${grpcHost} → ${address}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error(
        `[bootstrap] GRPC_AUDIO DNS FAILED | host=${grpcHost} | ${msg}`,
        '\n[bootstrap] Fix: backend + Python no MESMO projeto Railway; Private Networking ligado; GRPC_AUDIO_SERVICE_URL = nome exato do serviço Python no painel + .railway.internal:50051 (não use o domínio público *.up.railway.app como host interno).',
      );
    }
  }
}
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap] fatal', err);
  process.exit(1);
});
