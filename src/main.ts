import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { EgressAudioGateway } from './egress/egress-audio.gateway';
import { FeedbackGrpcServer } from './feedback/feedback.grpc.server';
import { RedisIoAdapter } from './redis-io.adapter';
import * as dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
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

function parseCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[bootstrap] CORS_ORIGINS is empty in production — refusing all cross-origin requests.',
      );
      return [];
    }
    return true; // dev: allow all
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildGrpcServerCredentials(): grpc.ServerCredentials {
  const isProd = process.env.NODE_ENV === 'production';
  const certPath = process.env.GRPC_TLS_SERVER_CERT;
  const keyPath = process.env.GRPC_TLS_SERVER_KEY;
  const caPath = process.env.GRPC_TLS_CLIENT_CA;

  if (certPath && keyPath) {
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);
    const rootCerts = caPath ? readFileSync(caPath) : null;
    const requireClientCert = Boolean(caPath);
    return grpc.ServerCredentials.createSsl(
      rootCerts,
      [{ cert_chain: cert, private_key: key }],
      requireClientCert,
    );
  }

  if (isProd) {
    throw new Error(
      'gRPC insecure credentials refused in production. Set GRPC_TLS_SERVER_CERT + GRPC_TLS_SERVER_KEY (and GRPC_TLS_CLIENT_CA for mTLS).',
    );
  }
  console.warn(
    '[bootstrap] gRPC running with insecure credentials (dev only). Configure GRPC_TLS_* for production.',
  );
  return grpc.ServerCredentials.createInsecure();
}

dotenv.config({ path: resolve(process.cwd(), '.env') });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(process.cwd(), 'env') });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.use(
    helmet({
      contentSecurityPolicy: false, // APIs; renderer/extensions set their own CSP
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
    console.log(
      '[bootstrap] Socket.IO Redis adapter enabled | REDIS_URL=(set)',
    );
  } else {
    console.log(
      '[bootstrap] Socket.IO in-memory adapter (single replica or dev only) — set REDIS_URL for multi-replica broadcast',
    );
  }

  app.enableCors({
    origin: parseCorsOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Requested-With',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  const port = process.env.PORT ?? 3001;
  const httpServer = await app.listen(port);

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
      buildGrpcServerCredentials(),
      (error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      },
    );
  });

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
      console.log(`[bootstrap] GRPC_AUDIO DNS OK | ${grpcHost} → ${address}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[bootstrap] GRPC_AUDIO DNS FAILED | host=${grpcHost} | ${msg}`,
        '\n[bootstrap] Fix: backend + Python no MESMO projeto Railway; Private Networking ligado; GRPC_AUDIO_SERVICE_URL = nome exato do serviço Python no painel + .railway.internal:50051 (não use o domínio público *.up.railway.app como host interno).',
      );
    }
  }
}
bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
  process.exit(1);
});
