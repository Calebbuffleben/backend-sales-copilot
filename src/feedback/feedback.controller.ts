import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import type { FeedbackSeverity, FeedbackType } from '@prisma/client';
import { FeedbackService } from './feedback.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AdminOnly } from '../auth/decorators/roles.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Get('metrics/:meetingId')
  async getMetrics(
    @Param('meetingId') meetingId: string,
    @CurrentUser() user: TenantContext | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.feedbackService.getFeedbackMetrics(user.tenantId, meetingId);
  }

  @Post('test/emit')
  @AdminOnly()
  async emitSyntheticFeedback(
    @Body()
    payload: {
      meetingId: string;
      participantId?: string;
      type?: FeedbackType;
      severity?: FeedbackSeverity;
      message?: string;
      tsMs?: number;
      metadata?: Record<string, unknown>;
    },
    @CurrentUser() user: TenantContext | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    const enabled =
      String(process.env.ENABLE_FEEDBACK_TEST_ENDPOINT || '').toLowerCase() ===
      'true';
    if (!enabled) {
      throw new ForbiddenException(
        'Synthetic feedback endpoint disabled (set ENABLE_FEEDBACK_TEST_ENDPOINT=true)',
      );
    }
    const now = Date.now();
    const ts = new Date(
      Number.isFinite(payload.tsMs) ? Number(payload.tsMs) : now,
    );
    const created = await this.feedbackService.createFeedback({
      tenantId: user.tenantId,
      meetingId: payload.meetingId,
      participantId: payload.participantId || 'desktop-parity-test',
      type: payload.type || 'llm_insight',
      severity: payload.severity || 'info',
      ts,
      windowStart: new Date(ts.getTime() - 1500),
      windowEnd: ts,
      message: payload.message || 'synthetic feedback parity probe',
      metadata: {
        source: 'phase7-parity-test',
        ...(payload.metadata || {}),
      },
    });

    return {
      ok: true,
      id: created.id,
      tenantId: created.tenantId,
      meetingId: created.meetingId,
      participantId: created.participantId,
      type: created.type,
      severity: created.severity,
      ts: created.ts.toISOString(),
      message: created.message,
    };
  }
}
