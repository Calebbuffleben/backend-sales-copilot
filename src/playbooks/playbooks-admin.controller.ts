import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';

import { AdminOnly } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../tenancy/tenant-context.types';
import {
  CreatePlaybookTemplateDto,
  UpdatePlaybookTemplateDto,
} from './dto/playbook-template.dto';
import { PLAYBOOK_PDF_MAX_BYTES } from './playbook-pdf.constants';
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

  @Delete(':id/source-pdf')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  async removeSourcePdf(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
  ) {
    if (!user) throw new UnauthorizedException();
    return this.templates.clearSourcePdf(user.tenantId, id);
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

  @Post(':id/source-pdf')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: PLAYBOOK_PDF_MAX_BYTES, files: 1 },
    }),
  )
  async uploadSourcePdf(
    @CurrentUser() user: TenantContext | undefined,
    @Param('id') id: string,
    @UploadedFile()
    file:
      | {
          buffer: Buffer;
          originalname: string;
          mimetype: string;
          size: number;
        }
      | undefined,
  ) {
    if (!user) throw new UnauthorizedException();
    if (!file) {
      throw new BadRequestException('PDF file required (multipart field "file")');
    }
    return this.templates.setSourcePdf(user.tenantId, id, file);
  }
}
