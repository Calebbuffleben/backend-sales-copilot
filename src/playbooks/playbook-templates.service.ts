import {
  BadRequestException,
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
import { extractPlaybookPdfText } from './playbook-pdf-extract';
import { PLAYBOOK_PDF_MAX_BYTES } from './playbook-pdf.constants';

export type PlaybookTemplateResponse = {
  id: string;
  tenantId: string;
  key: string;
  title: string;
  description: string | null;
  steps: Prisma.JsonValue;
  sourcePdfFileName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PlaybookRow = PlaybookTemplateResponse & {
  sourceText?: string | null;
  sourceTextExcerpt?: string | null;
};

/** Narrow CRUD surface — runtime matches Prisma delegate after `prisma generate`. */
type PlaybookTemplateDelegate = {
  findMany(args: unknown): Promise<PlaybookRow[]>;
  create(args: unknown): Promise<PlaybookRow>;
  findFirst(args: unknown): Promise<PlaybookRow | null>;
  update(args: unknown): Promise<PlaybookRow>;
  delete(args: unknown): Promise<unknown>;
};

function toPublic(row: PlaybookRow): PlaybookTemplateResponse {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    title: row.title,
    description: row.description,
    steps: row.steps,
    sourcePdfFileName: row.sourcePdfFileName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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
    const rows = await this.playbook.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
      select: {
        id: true,
        tenantId: true,
        key: true,
        title: true,
        description: true,
        steps: true,
        sourcePdfFileName: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map(toPublic);
  }

  /** Live catalog: include excerpt only (never full sourceText / PDF bytes). */
  async listForCatalog(tenantId: string): Promise<
    Array<{
      key: string;
      title: string;
      description: string | null;
      steps: Prisma.JsonValue;
      sourceTextExcerpt: string | null;
    }>
  > {
    const rows = await this.playbook.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        title: true,
        description: true,
        steps: true,
        sourceTextExcerpt: true,
      },
    });
    return rows.map((r) => ({
      key: r.key,
      title: r.title,
      description: r.description,
      steps: r.steps,
      sourceTextExcerpt: r.sourceTextExcerpt ?? null,
    }));
  }

  async create(
    tenantId: string,
    dto: CreatePlaybookTemplateDto,
  ): Promise<PlaybookTemplateResponse> {
    const steps = dto.steps as unknown as Prisma.InputJsonValue;
    try {
      const row = await this.playbook.create({
        data: {
          tenantId,
          key: dto.key.trim(),
          title: dto.title.trim(),
          description: dto.description?.trim() ?? null,
          steps,
        },
      });
      return toPublic(row);
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

    const row = await this.playbook.update({
      where: { id },
      data,
    });
    return toPublic(row);
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

  async setSourcePdf(
    tenantId: string,
    id: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<PlaybookTemplateResponse> {
    const existing = await this.playbook.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Playbook template not found');
    }

    if (!file?.buffer?.length) {
      throw new BadRequestException('PDF file required');
    }
    if (file.size > PLAYBOOK_PDF_MAX_BYTES) {
      throw new BadRequestException(
        `PDF exceeds max size of ${PLAYBOOK_PDF_MAX_BYTES} bytes`,
      );
    }
    const name = (file.originalname || 'document.pdf').trim();
    const mimeOk =
      file.mimetype === 'application/pdf' ||
      name.toLowerCase().endsWith('.pdf');
    if (!mimeOk) {
      throw new BadRequestException('Only application/pdf is accepted');
    }

    let extracted: { sourceText: string; sourceTextExcerpt: string };
    try {
      extracted = await extractPlaybookPdfText(file.buffer);
    } catch {
      throw new BadRequestException('Could not extract text from PDF');
    }
    if (!extracted.sourceTextExcerpt) {
      throw new BadRequestException(
        'PDF has no extractable text (scanned images are not supported)',
      );
    }

    const row = await this.playbook.update({
      where: { id },
      data: {
        sourcePdfFileName: name.slice(0, 255),
        sourceText: extracted.sourceText,
        sourceTextExcerpt: extracted.sourceTextExcerpt,
      },
    });
    return toPublic(row);
  }

  async clearSourcePdf(
    tenantId: string,
    id: string,
  ): Promise<PlaybookTemplateResponse> {
    const existing = await this.playbook.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Playbook template not found');
    }

    const row = await this.playbook.update({
      where: { id },
      data: {
        sourcePdfFileName: null,
        sourceText: null,
        sourceTextExcerpt: null,
      },
    });
    return toPublic(row);
  }
}
