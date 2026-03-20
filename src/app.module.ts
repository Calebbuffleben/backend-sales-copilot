import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { FeedbackModule } from './feedback/feedback.module';
import { EgressModule } from './egress/egress.module';
import { PipelineModule } from './pipeline/pipeline.module';

@Module({
  imports: [PrismaModule, FeedbackModule, EgressModule, PipelineModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
