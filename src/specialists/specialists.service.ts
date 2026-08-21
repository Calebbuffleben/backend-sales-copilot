import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SpecialistSource,
  SpecialistStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import {
  DryRunSpecialistDto,
  PatchSpecialistDto,
  RegisterBuiltinSpecialistDto,
  UpsertSpecialistDto,
} from './dto/specialist.dto';
import { compileSpecialistPrompt } from './specialist-prompt';

const EDITABLE_WHEN_CODE: (keyof PatchSpecialistDto)[] = ['enabled'];

@Injectable()
export class SpecialistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  list(query: { q?: string; status?: string; source?: string }) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const where: Prisma.SpecialistTemplateWhereInput = {
        ...(query.status
          ? { status: query.status as SpecialistStatus }
          : {}),
        ...(query.source
          ? { source: query.source as SpecialistSource }
          : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { key: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const items = await this.prisma.specialistTemplate.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { versions: true } } },
      });
      return { items, total: items.length };
    });
  }

  get(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
        include: {
          versions: { orderBy: { version: 'desc' }, take: 20 },
        },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      return row;
    });
  }

  create(dto: UpsertSpecialistDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const existing = await this.prisma.specialistTemplate.findUnique({
        where: { key: dto.key },
      });
      if (existing) throw new ConflictException(`key ${dto.key} already exists`);
      return this.prisma.specialistTemplate.create({
        data: {
          key: dto.key,
          name: dto.name,
          description: dto.description ?? '',
          instructions: dto.instructions ?? '',
          tone: dto.tone ?? '',
          exampleMessage: dto.exampleMessage ?? '',
          triggerPhases: dto.triggerPhases ?? [],
          triggerKeywords: dto.triggerKeywords ?? [],
          minConfidence: dto.minConfidence ?? 0.6,
          cooldownSec: dto.cooldownSec ?? 15,
          priority: dto.priority ?? 100,
          model: dto.model ?? 'gemini-2.5-flash',
          maxLatencyMs: dto.maxLatencyMs ?? 4000,
          icon: dto.icon,
          color: dto.color,
          source: SpecialistSource.CUSTOM,
          status: SpecialistStatus.DRAFT,
        },
      });
    });
  }

  update(id: string, dto: PatchSpecialistDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      if (row.source === SpecialistSource.CODE) {
        const extras = Object.keys(dto).filter(
          (k) => !EDITABLE_WHEN_CODE.includes(k as keyof PatchSpecialistDto),
        );
        if (extras.length) {
          throw new BadRequestException(
            'Code specialists are read-only except enabled',
          );
        }
      }
      return this.prisma.specialistTemplate.update({
        where: { id },
        data: {
          ...dto,
          status:
            row.source === SpecialistSource.CUSTOM &&
            row.status === SpecialistStatus.PUBLISHED &&
            dto.enabled === undefined
              ? SpecialistStatus.DRAFT
              : undefined,
        },
      });
    });
  }

  clone(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      const key = `${row.key}_copy`.slice(0, 64);
      let candidate = key;
      let n = 2;
      while (
        await this.prisma.specialistTemplate.findUnique({
          where: { key: candidate },
        })
      ) {
        candidate = `${row.key}_copy${n}`.slice(0, 64);
        n += 1;
      }
      return this.prisma.specialistTemplate.create({
        data: {
          key: candidate,
          name: `${row.name} (cópia)`,
          description: row.description,
          instructions: row.instructions,
          tone: row.tone,
          exampleMessage: row.exampleMessage,
          triggerPhases: row.triggerPhases,
          triggerKeywords: row.triggerKeywords,
          minConfidence: row.minConfidence,
          cooldownSec: row.cooldownSec,
          priority: row.priority,
          model: row.model,
          maxLatencyMs: row.maxLatencyMs,
          icon: row.icon,
          color: row.color,
          source: SpecialistSource.CUSTOM,
          status: SpecialistStatus.DRAFT,
          enabled: false,
        },
      });
    });
  }

  async publish(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      if (!row.lastDryRunAt) {
        throw new BadRequestException(
          'Dry-run at least once before publishing',
        );
      }
      const nextVersion = (row.versions[0]?.version ?? 0) + 1;
      const snapshot = this.toSnapshot(row);
      await this.prisma.specialistVersion.create({
        data: {
          specialistId: row.id,
          version: nextVersion,
          snapshot,
        },
      });
      return this.prisma.specialistTemplate.update({
        where: { id },
        data: {
          status: SpecialistStatus.PUBLISHED,
          publishedAt: new Date(),
          enabled: true,
        },
      });
    });
  }

  rollback(id: string, version: number) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const ver = await this.prisma.specialistVersion.findUnique({
        where: { specialistId_version: { specialistId: id, version } },
      });
      if (!ver) throw new NotFoundException('Version not found');
      const snap = ver.snapshot as Record<string, unknown>;
      return this.prisma.specialistTemplate.update({
        where: { id },
        data: {
          name: String(snap.name ?? ''),
          description: String(snap.description ?? ''),
          instructions: String(snap.instructions ?? ''),
          tone: String(snap.tone ?? ''),
          exampleMessage: String(snap.exampleMessage ?? ''),
          triggerPhases: Array.isArray(snap.triggerPhases)
            ? (snap.triggerPhases as string[])
            : [],
          triggerKeywords: Array.isArray(snap.triggerKeywords)
            ? (snap.triggerKeywords as string[])
            : [],
          minConfidence: Number(snap.minConfidence ?? 0.6),
          cooldownSec: Number(snap.cooldownSec ?? 15),
          priority: Number(snap.priority ?? 100),
          model: String(snap.model ?? 'gemini-2.5-flash'),
          maxLatencyMs: Number(snap.maxLatencyMs ?? 4000),
          status: SpecialistStatus.DRAFT,
        },
      });
    });
  }

  archive(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      return this.prisma.specialistTemplate.update({
        where: { id },
        data: { status: SpecialistStatus.ARCHIVED, enabled: false },
      });
    });
  }

  async dryRun(id: string, dto: DryRunSpecialistDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      const prompt = compileSpecialistPrompt({
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        tone: row.tone,
        exampleMessage: row.exampleMessage,
        transcript: dto.transcript,
        hostContext: dto.hostContext,
      });
      const started = Date.now();
      const llm = await this.callGemini(prompt, row.model);
      await this.prisma.specialistTemplate.update({
        where: { id },
        data: { lastDryRunAt: new Date() },
      });
      return {
        prompt,
        latencyMs: Date.now() - started,
        skippedLlm: llm.skipped,
        output: llm.output,
      };
    });
  }

  catalog() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const rows = await this.prisma.specialistTemplate.findMany({
        where: {
          enabled: true,
          OR: [
            { status: SpecialistStatus.PUBLISHED },
            { source: SpecialistSource.CODE },
          ],
        },
        orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      });
      return {
        specialists: rows.map((r) => ({
          key: r.key,
          name: r.name,
          description: r.description,
          instructions: r.instructions,
          tone: r.tone,
          exampleMessage: r.exampleMessage,
          triggerPhases: r.triggerPhases,
          triggerKeywords: r.triggerKeywords,
          minConfidence: r.minConfidence,
          cooldownSec: r.cooldownSec,
          priority: r.priority,
          model: r.model,
          maxLatencyMs: r.maxLatencyMs,
          source: r.source === SpecialistSource.CODE ? 'code' : 'custom',
          icon: r.icon,
          color: r.color,
        })),
      };
    });
  }

  registerBuiltins(items: RegisterBuiltinSpecialistDto[]) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      let upserted = 0;
      for (const item of items) {
        await this.prisma.specialistTemplate.upsert({
          where: { key: item.key },
          create: {
            key: item.key,
            name: item.name,
            description: item.description ?? '',
            instructions: item.instructions ?? '',
            triggerPhases: item.triggerPhases ?? [],
            triggerKeywords: item.triggerKeywords ?? [],
            model: item.model ?? 'gemini-2.5-flash',
            maxLatencyMs: item.maxLatencyMs ?? 4000,
            priority: item.priority ?? 100,
            source: SpecialistSource.CODE,
            status: SpecialistStatus.PUBLISHED,
            enabled: true,
            publishedAt: new Date(),
            lastDryRunAt: new Date(),
          },
          update: {
            name: item.name,
            description: item.description ?? '',
            instructions: item.instructions ?? '',
            triggerPhases: item.triggerPhases ?? [],
            triggerKeywords: item.triggerKeywords ?? [],
            model: item.model ?? 'gemini-2.5-flash',
            maxLatencyMs: item.maxLatencyMs ?? 4000,
            priority: item.priority ?? 100,
            source: SpecialistSource.CODE,
            status: SpecialistStatus.PUBLISHED,
          },
        });
        upserted += 1;
      }
      return { upserted };
    });
  }

  getPreference(userId: string, tenantId: string) {
    return this.prisma.userSpecialistPreference.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
  }

  savePreference(userId: string, tenantId: string, keys: string[]) {
    return this.prisma.userSpecialistPreference.upsert({
      where: { userId_tenantId: { userId, tenantId } },
      create: { userId, tenantId, specialistKeys: keys },
      update: { specialistKeys: keys },
    });
  }

  metrics(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const row = await this.prisma.specialistTemplate.findUnique({
        where: { id },
      });
      if (!row) throw new NotFoundException('Specialist not found');
      const events = await this.prisma.operationalEvent.findMany({
        where: { stage: 'specialist.executed', message: { contains: row.key } },
        orderBy: { timestamp: 'desc' },
        take: 200,
      });
      const durations = events
        .map((e) => e.durationMs)
        .filter((n): n is number => typeof n === 'number');
      const p95 = percentile(durations, 0.95);
      return {
        key: row.key,
        executions: events.length,
        latencyP95Ms: p95,
        recent: events.slice(0, 20),
      };
    });
  }

  private toSnapshot(row: {
    name: string;
    description: string;
    instructions: string;
    tone: string;
    exampleMessage: string;
    triggerPhases: string[];
    triggerKeywords: string[];
    minConfidence: number;
    cooldownSec: number;
    priority: number;
    model: string;
    maxLatencyMs: number;
  }) {
    return {
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      tone: row.tone,
      exampleMessage: row.exampleMessage,
      triggerPhases: row.triggerPhases,
      triggerKeywords: row.triggerKeywords,
      minConfidence: row.minConfidence,
      cooldownSec: row.cooldownSec,
      priority: row.priority,
      model: row.model,
      maxLatencyMs: row.maxLatencyMs,
    };
  }

  private async callGemini(
    prompt: string,
    model: string,
  ): Promise<{ skipped: boolean; output: unknown }> {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return { skipped: true, output: { note: 'GEMINI_API_KEY unset; prompt only' } };
    }
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 400,
            responseMimeType: 'application/json',
          },
        }),
      });
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text =
        json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      try {
        return { skipped: false, output: JSON.parse(text) };
      } catch {
        return { skipped: false, output: { raw: text } };
      }
    } catch (err) {
      return {
        skipped: false,
        output: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? null;
}
