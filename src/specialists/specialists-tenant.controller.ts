import {
  Body,
  Controller,
  Get,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { SaveSpecialistPreferenceDto } from './dto/specialist.dto';
import { SpecialistsService } from './specialists.service';

@Controller('specialists')
export class SpecialistsTenantController {
  constructor(private readonly specialists: SpecialistsService) {}

  @Get('catalog')
  @SkipThrottle()
  catalog() {
    return this.specialists.catalog();
  }

  @Get('preferences')
  async getPreference(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    const row = await this.specialists.getPreference(user.userId, user.tenantId);
    return { specialistKeys: row?.specialistKeys ?? [] };
  }

  @Put('preferences')
  async savePreference(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: SaveSpecialistPreferenceDto,
  ) {
    if (!user) throw new UnauthorizedException();
    const row = await this.specialists.savePreference(
      user.userId,
      user.tenantId,
      dto.specialistKeys,
    );
    return { specialistKeys: row.specialistKeys };
  }
}
