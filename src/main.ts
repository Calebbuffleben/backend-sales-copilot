import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EgressAudioGateway } from './egress/egress-audio.gateway';
import { FeedbackGrpcServer } from './feedback/feedback.grpc.server';
import * as dotenv from 'dotenv';
import { join, resolve } from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

// Load environment variables from .env file (fallback to env file if .env doesn't exist)
dotenv.config({ path: resolve(process.cwd(), '.env') });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: resolve(process.cwd(), 'env') });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });

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
}
bootstrap();
