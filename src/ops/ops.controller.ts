import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import { OpsService } from './ops.service';

@Controller('ops')
@Public()
@UseGuards(PlatformAdminGuard)
@SkipThrottle()
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('meetings/live')
  liveMeetings() {
    return this.ops.liveMeetings();
  }

  @Get('meetings/today')
  meetingsToday() {
    return this.ops.meetingsToday();
  }

  @Get('meetings/:meetingId')
  meeting(@Param('meetingId') meetingId: string) {
    return this.ops.meeting(meetingId);
  }

  @Get('pipeline/summary')
  pipelineSummary() {
    return this.ops.pipelineSummary();
  }

  @Get('ai/summary')
  aiSummary() {
    return this.ops.aiSummary();
  }

  @Get('feedbacks/recent')
  recentFeedbacks(@Query('limit') limit?: string) {
    return this.ops.recentFeedbacks(limit ? Number(limit) : undefined);
  }

  @Get('logs')
  logs(
    @Query('meetingId') meetingId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('userId') userId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ops.logs({
      meetingId,
      tenantId,
      userId,
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('logs/timeline')
  timeline(@Query('meetingId') meetingId?: string) {
    return this.ops.logs({ meetingId, limit: 200 });
  }

  @Get('metrics/saas-summary')
  saasSummary() {
    return this.ops.saasSummary();
  }
}
