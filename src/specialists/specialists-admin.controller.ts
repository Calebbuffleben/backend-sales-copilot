import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import {
  DryRunSpecialistDto,
  PatchSpecialistDto,
  UpsertSpecialistDto,
} from './dto/specialist.dto';
import { SpecialistsService } from './specialists.service';

@Controller('platform-admin/specialists')
@Public()
@UseGuards(PlatformAdminGuard)
@SkipThrottle()
export class SpecialistsAdminController {
  constructor(private readonly specialists: SpecialistsService) {}

  @Get()
  list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
  ) {
    return this.specialists.list({ q, status, source });
  }

  @Post()
  create(@Body() dto: UpsertSpecialistDto) {
    return this.specialists.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.specialists.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: PatchSpecialistDto) {
    return this.specialists.update(id, dto);
  }

  @Post(':id/clone')
  clone(@Param('id') id: string) {
    return this.specialists.clone(id);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return this.specialists.publish(id);
  }

  @Post(':id/rollback/:version')
  rollback(
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.specialists.rollback(id, version);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.specialists.archive(id);
  }

  @Post(':id/dry-run')
  dryRun(@Param('id') id: string, @Body() dto: DryRunSpecialistDto) {
    return this.specialists.dryRun(id, dto);
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string) {
    return this.specialists.metrics(id);
  }
}
