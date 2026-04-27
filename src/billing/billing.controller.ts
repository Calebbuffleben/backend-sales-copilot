import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { BillingService } from './billing.service';
import { UpgradePlanDto } from './dto/billing.dto';
import { PLAN_MAX_USERS } from './plan-limits';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Subscription snapshot for the current tenant. Every member can read
   * this to know seat limits and whether the tenant is at capacity.
   */
  @Get('subscription')
  @SkipThrottle()
  async subscription(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const snapshot = await this.billing.getSubscription(user.tenantId);
    return { ...snapshot, planLimits: PLAN_MAX_USERS };
  }

  /**
   * Switch the tenant's plan. Admin-only. Hard-coded plan → seat map
   * (see plan-limits.ts). No real payment processing in this build.
   */
  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async upgrade(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: UpgradePlanDto,
    @Req() req: Request,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.billing.changePlan(user.tenantId, user.userId, dto.plan, {
      ip: readIp(req),
      userAgent: req.get?.('user-agent') ?? undefined,
    });
  }
}

function readIp(req: Request): string | undefined {
  return (
    (req.headers['x-forwarded-for'] as string | undefined)
      ?.split(',')[0]
      ?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined
  );
}
