import { Module } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { GrpcAudioClient } from './grpc-audio.client';

@Module({
  providers: [PipelineService, GrpcAudioClient],
  exports: [PipelineService, GrpcAudioClient],
})
export class PipelineModule {}
