import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export type AssistantTurnInput = {
  tenantId: string;
  meetingId: string;
  turnId: string;
  speaker: string;
  textEn: string;
  textPt: string;
  summaryPt?: string;
  seq: number;
  startedAtMs: number;
  endedAtMs: number;
};

export type AssistantRecapInput = {
  tenantId: string;
  meetingId: string;
  summary: string;
  decisions?: unknown;
  highlights?: unknown;
  actionItems?: unknown;
};

export type AssistantActionItem = {
  task: string;
  owner: string;
  due: string;
};

@Injectable()
export class AssistantService {
  constructor(private readonly prisma: PrismaService) {}

  async saveTurn(input: AssistantTurnInput) {
    const tenantId = requiredId(input.tenantId, 'tenantId');
    const meetingId = requiredId(input.meetingId, 'meetingId');
    const turnId = requiredId(input.turnId, 'turnId');
    const speaker = input.speaker === 'you' ? 'you' : 'meeting';
    const seq = Number(input.seq);
    if (!Number.isFinite(seq)) {
      throw new BadRequestException('seq must be a number');
    }
    const startedAt = millisToDate(input.startedAtMs, 'startedAtMs');
    const endedAt = millisToDate(input.endedAtMs, 'endedAtMs');
    const data = {
      speaker,
      textEn: String(input.textEn || ''),
      textPt: String(input.textPt || ''),
      summaryPt: String(input.summaryPt || ''),
      seq: Math.trunc(seq),
      startedAt,
      endedAt,
    };

    const existing = await this.prisma.transcriptTurn.findFirst({
      where: { tenantId, meetingId, turnId },
    });
    if (existing) {
      return this.prisma.transcriptTurn.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.transcriptTurn.create({
      data: { tenantId, meetingId, turnId, ...data },
    });
  }

  async saveRecap(input: AssistantRecapInput) {
    const tenantId = requiredId(input.tenantId, 'tenantId');
    const meetingId = requiredId(input.meetingId, 'meetingId');
    const data = {
      summary: String(input.summary || ''),
      decisions: stringList(input.decisions) as Prisma.InputJsonValue,
      highlights: stringList(input.highlights) as Prisma.InputJsonValue,
      actionItems: actionItems(input.actionItems) as Prisma.InputJsonValue,
    };
    const existing = await this.prisma.meetingRecap.findFirst({
      where: { tenantId, meetingId },
    });
    if (existing) {
      return this.prisma.meetingRecap.update({
        where: { id: existing.id },
        data,
      });
    }
    return this.prisma.meetingRecap.create({
      data: { tenantId, meetingId, ...data },
    });
  }

  async getMeeting(tenantId: string, meetingId: string) {
    const turns = await this.prisma.transcriptTurn.findMany({
      where: { tenantId, meetingId },
      orderBy: { seq: 'asc' },
    });
    const recap = await this.prisma.meetingRecap.findFirst({
      where: { tenantId, meetingId },
    });
    return {
      meetingId,
      turns: turns.map((turn) => ({
        turnId: turn.turnId,
        speaker: turn.speaker,
        textPt: turn.textPt,
        summaryPt: turn.summaryPt,
        seq: turn.seq,
        startedAt: turn.startedAt.toISOString(),
        endedAt: turn.endedAt.toISOString(),
      })),
      recap: recap
        ? {
            summary: recap.summary,
            decisions: stringList(recap.decisions),
            highlights: stringList(recap.highlights),
            actionItems: actionItems(recap.actionItems),
          }
        : null,
    };
  }
}

function requiredId(value: string, name: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new BadRequestException(`${name} is required`);
  return trimmed;
}

function millisToDate(value: number, name: string): Date {
  const millis = Number(value);
  if (!Number.isFinite(millis)) {
    throw new BadRequestException(`${name} must be a timestamp`);
  }
  return new Date(millis);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function actionItems(value: unknown): AssistantActionItem[] {
  if (!Array.isArray(value)) return [];
  const items: AssistantActionItem[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      items.push({ task: item.trim(), owner: '', due: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const task = String(record.task || '').trim();
    if (!task) continue;
    items.push({
      task,
      owner: String(record.owner || '').trim(),
      due: String(record.due || '').trim(),
    });
  }
  return items;
}
