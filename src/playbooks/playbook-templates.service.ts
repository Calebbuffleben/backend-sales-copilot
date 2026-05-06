import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePlaybookTemplateDto,
  UpdatePlaybookTemplateDto,
} from './dto/playbook-template.dto';

export type PlaybookTemplateResponse = {
  id: string;
  tenantId: string;
  key: string;
  title: string;
  description: string | null;
  steps: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
};

/** Narrow CRUD surface — runtime matches Prisma delegate after `prisma generate`. */
type PlaybookTemplateDelegate = {
  findMany(args: unknown): Promise<PlaybookTemplateResponse[]>;
  create(args: unknown): Promise<PlaybookTemplateResponse>;
  findFirst(args: unknown): Promise<PlaybookTemplateResponse | null>;
  update(args: unknown): Promise<PlaybookTemplateResponse>;
  delete(args: unknown): Promise<unknown>;
};

@Injectable()
export class PlaybookTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  private get playbook(): PlaybookTemplateDelegate {
    return (
      this.prisma as unknown as {
        playbookTemplate: PlaybookTemplateDelegate;
      }
    ).playbookTemplate;
  }

  async list(tenantId: string): Promise<PlaybookTemplateResponse[]> {
    return this.playbook.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
    });
  }

  async create(
    tenantId: string,
    dto: CreatePlaybookTemplateDto,
  ): Promise<PlaybookTemplateResponse> {
    const steps = dto.steps as unknown as Prisma.InputJsonValue;
    try {
      return await this.playbook.create({
        data: {
          tenantId,
          key: dto.key.trim(),
          title: dto.title.trim(),
          description: dto.description?.trim() ?? null,
          steps,
        },
      });
    } catch (e: unknown) {
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        (e as { code: string }).code === 'P2002'
      ) {
        throw new ConflictException(
          `Playbook template with key "${dto.key}" already exists`,
        );
      }
      throw e;
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdatePlaybookTemplateDto,
  ): Promise<PlaybookTemplateResponse> {
    const existing = await this.playbook.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Playbook template not found');
    }

    const data: {
      title?: string;
      description?: string;
      steps?: Prisma.InputJsonValue;
    } = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) {
      data.description = dto.description.trim();
    }
    if (dto.steps !== undefined) {
      data.steps = dto.steps as unknown as Prisma.InputJsonValue;
    }

    return this.playbook.update({
      where: { id },
      data,
    });
  }

  async remove(tenantId: string, id: string): Promise<{ deleted: true }> {
    const existing = await this.playbook.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Playbook template not found');
    }

    await this.playbook.delete({ where: { id } });
    return { deleted: true as const };
  }
}
