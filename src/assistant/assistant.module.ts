import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AssistantController } from './assistant.controller';
import { AssistantInternalController } from './assistant-internal.controller';
import { AssistantService } from './assistant.service';

@Module({
  imports: [AuthModule],
  controllers: [AssistantController, AssistantInternalController],
  providers: [AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
