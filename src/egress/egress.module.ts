import { Module } from '@nestjs/common';
import { EgressAudioGateway } from './egress-audio.gateway';
import { PipelineModule } from '../pipeline/pipeline.module';

@Module({
  imports: [PipelineModule],
  providers: [EgressAudioGateway],
  exports: [EgressAudioGateway],
})
export class EgressModule {}
