import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ManagerAccess } from '../auth/decorators/roles.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { MonitorService } from './monitor.service';
import { SosDto, WhisperDto } from './dto/monitor.dto';

@Controller('monitor')
export class MonitorController {
  constructor(private readonly monitor: MonitorService) {}

  @Get('meetings/live')
  @SkipThrottle()
  @ManagerAccess()
  live(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.monitor.liveMeetings(user.tenantId);
  }

  @Get('meetings/:meetingId')
  @SkipThrottle()
  @ManagerAccess()
  detail(
    @CurrentUser() user: TenantContext | undefined,
    @Param('meetingId') meetingId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.monitor.meetingDetail(user.tenantId, meetingId);
  }

  @Post('meetings/:meetingId/whisper')
  @ManagerAccess()
  whisper(
    @CurrentUser() user: TenantContext | undefined,
    @Param('meetingId') meetingId: string,
    @Body() dto: WhisperDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.monitor.sendWhisper({
      tenantId: user.tenantId,
      meetingId,
      actorUserId: user.userId,
      message: dto.message.trim(),
    });
  }

  @Get('alerts')
  @SkipThrottle()
  @ManagerAccess()
  alerts(
    @CurrentUser() user: TenantContext | undefined,
    @Query('since') since?: string,
  ) {
    if (!user) throw new UnauthorizedException();
    const parsed = since ? new Date(since) : undefined;
    return this.monitor.listAlerts(
      user.tenantId,
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
    );
  }

  @Patch('alerts/:alertId/ack')
  @ManagerAccess()
  ack(
    @CurrentUser() user: TenantContext | undefined,
    @Param('alertId') alertId: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.monitor.acknowledgeAlert(user.tenantId, alertId, user.userId);
  }

  /** Any authenticated member (vendedor) can raise SOS. */
  @Post('sos')
  sos(@CurrentUser() user: TenantContext | undefined, @Body() dto: SosDto) {
    if (!user) throw new UnauthorizedException();
    return this.monitor.reportSos({
      tenantId: user.tenantId,
      meetingId: dto.meetingId.trim(),
      userId: user.userId,
    });
  }
}
