import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { MonitorController } from './monitor.controller';
import { MonitorGateway } from './monitor.gateway';
import { MonitorService } from './monitor.service';
import { MonitorSnapshotStore } from './monitor.snapshot-store';

@Module({
  imports: [AuthModule, forwardRef(() => FeedbackModule)],
  controllers: [MonitorController],
  providers: [MonitorService, MonitorGateway, MonitorSnapshotStore],
  exports: [MonitorService],
})
export class MonitorModule {}
