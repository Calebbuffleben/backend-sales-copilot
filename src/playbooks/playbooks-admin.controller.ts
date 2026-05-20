import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import {
  CreatePlaybookTemplateDto,
  UpdatePlaybookTemplateDto,
} from './dto/playbook-template.dto';
import { PlaybookTemplatesService } from './playbook-templates.service';

@Controller('playbooks')
export class PlaybooksAdminController {
  constructor(private readonly templates: PlaybookTemplatesService) {}

  @Get()
  @AdminOnly()
  @SkipThrottle()
  async list(@CurrentUser() user: TenantContext | undefined) {
    if (!user) throw new UnauthorizedException();
    return this.templates.list(user.tenantId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @AdminOnly()
  async create(
    @CurrentUser() user: TenantContext | undefined,
    @Body() dto: CreatePlaybookTemplateDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.templates.create(user.tenantId, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async update(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
    @Body() dto: UpdatePlaybookTemplateDto,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.templates.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async remove(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.templates.remove(user.tenantId, id);
  }
}
