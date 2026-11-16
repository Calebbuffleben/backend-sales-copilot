import { Controller, Get, Param, UnauthorizedException } from '@nestjs/common';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { AssistantService } from './assistant.service';

@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('meetings/:meetingId')
  async getMeeting(
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: TenantContext | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.assistant.getMeeting(user.tenantId, meetingId);
  }
}
