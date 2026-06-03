import { Module } from '@nestjs/common';
import { EgressAudioGateway } from './egress-audio.gateway';
import { PipelineModule } from '../pipeline/pipeline.module';
import { AuthModule } from '../auth/auth.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [PipelineModule, AuthModule, SessionsModule],
  providers: [EgressAudioGateway],
  exports: [EgressAudioGateway],
})
export class EgressModule {}
