import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  markConnectionOpen(input: {
    tenantId: string;
    meetingId: string;
    userId: string;
    participantId: string;
    participantRole: string;
    track: string;
    sampleRate: number;
    channels: number;
  }) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const now = new Date();
      await this.prisma.session.upsert({
        where: {
          tenantId_meetingId: {
            tenantId: input.tenantId,
            meetingId: input.meetingId,
          },
        },
        create: {
          tenantId: input.tenantId,
          meetingId: input.meetingId,
          roomName: input.meetingId,
          status: 'ACTIVE',
          startedAt: now,
          lastSeenAt: now,
          activeConnections: 1,
          metadata: input as unknown as Prisma.InputJsonValue,
        },
        update: {
          status: 'ACTIVE',
          endedAt: null,
          lastSeenAt: now,
          activeConnections: { increment: 1 },
          metadata: input as unknown as Prisma.InputJsonValue,
        },
      });
      await this.recordEvent({
        tenantId: input.tenantId,
        meetingId: input.meetingId,
        userId: input.userId,
        participantId: input.participantId,
        stage: 'meeting.connection.opened',
        message: 'Meeting audio connection opened',
        metadata: input,
      });
    });
  }

  markChunk(input: {
    tenantId: string;
    meetingId: string;
    userId: string;
    participantId: string;
    chunkBytes: number;
  }) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      await this.prisma.session.updateMany({
        where: { tenantId: input.tenantId, meetingId: input.meetingId },
        data: { lastSeenAt: new Date() },
      });
    });
  }

  markConnectionClosed(input: {
    tenantId: string;
    meetingId: string;
    userId: string;
    participantId: string;
    durationMs: number;
    chunksReceived: number;
    bytesReceived: number;
  }) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const session = await this.prisma.session.findUnique({
        where: {
          tenantId_meetingId: {
            tenantId: input.tenantId,
            meetingId: input.meetingId,
          },
        },
      });
      const nextConnections = Math.max(0, (session?.activeConnections ?? 1) - 1);
      await this.prisma.session.updateMany({
        where: { tenantId: input.tenantId, meetingId: input.meetingId },
        data: {
          activeConnections: nextConnections,
          audioSeconds: {
            increment: Math.max(0, Math.round(input.durationMs / 1000)),
          },
          lastSeenAt: new Date(),
          ...(nextConnections === 0
            ? { status: 'ENDED' as const, endedAt: new Date() }
            : {}),
        },
      });
      await this.recordEvent({
        tenantId: input.tenantId,
        meetingId: input.meetingId,
        userId: input.userId,
        participantId: input.participantId,
        stage: 'meeting.connection.closed',
        message: 'Meeting audio connection closed',
        durationMs: input.durationMs,
        metadata: input,
      });
    });
  }

  recordEvent(input: {
    service?: string;
    stage: string;
    message: string;
    tenantId?: string | null;
    meetingId?: string | null;
    userId?: string | null;
    participantId?: string | null;
    traceId?: string | null;
    severity?: string;
    durationMs?: number | null;
    metadata?: Record<string, unknown>;
  }) {
    return this.tenantCtx.runWithTenantBypass(async () =>
      this.prisma.operationalEvent.create({
        data: {
          service: input.service ?? 'backend',
          stage: input.stage,
          message: input.message,
          tenantId: input.tenantId ?? null,
          meetingId: input.meetingId ?? null,
          userId: input.userId ?? null,
          participantId: input.participantId ?? null,
          traceId: input.traceId ?? null,
          severity: input.severity ?? 'info',
          durationMs: input.durationMs ?? null,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      }),
    );
  }
}
