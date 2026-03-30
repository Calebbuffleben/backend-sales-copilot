import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackGateway } from './feedback.gateway';

// Import Prisma types from generated client
import type { Prisma } from '@prisma/client';
import type { FeedbackType, FeedbackSeverity } from '@prisma/client';

// FeedbackEvent type from Prisma
type FeedbackEvent = Prisma.FeedbackEventGetPayload<Record<string, never>>;

export interface FeedbackPayload {
  meetingId: string;
  participantId: string;
  type: FeedbackType;
  severity: FeedbackSeverity;
  ts: Date;
  windowStart: Date;
  windowEnd: Date;
  message: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feedbackGateway: FeedbackGateway,
  ) {}

  async createFeedback(payload: FeedbackPayload): Promise<FeedbackEvent> {
    const tIngressStartMs = Date.now();
    const windowEndMs = payload.windowEnd.getTime();
    const windowEndToIngressMs =
      Number.isFinite(windowEndMs) && windowEndMs > 0
        ? tIngressStartMs - windowEndMs
        : null;

    const eventId =
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as any).eventId
        : undefined;

    // Idempotency guard: prevent duplicate rows (and duplicate broadcasts)
    // when upstream retries the same window.
    const existing = await (
      this.prisma as unknown as {
        feedbackEvent: {
          findFirst: (args: { where: unknown }) => Promise<FeedbackEvent | null>;
          create: (args: { data: unknown }) => Promise<FeedbackEvent>;
        };
      }
    ).feedbackEvent.findFirst({
      where: {
        meetingId: payload.meetingId,
        participantId: payload.participantId,
        type: payload.type,
        severity: payload.severity,
        windowEnd: payload.windowEnd,
      } as unknown,
    });

    if (existing) {
      console.log(
        `[FeedbackService] idempotent hit (skip create) feedbackId=${existing.id} eventId=${String(
          eventId,
        )} windowEndToIngressMs=${windowEndToIngressMs}`,
      );
      // Still broadcast: ensures delivery even if retry happens before first emit.
      const room = `feedback:${existing.meetingId}`;
      this.feedbackGateway.broadcastFeedback(room, {
        id: existing.id,
        meetingId: existing.meetingId,
        participantId: existing.participantId,
        type: existing.type,
        severity: existing.severity,
        ts: existing.ts.toISOString(),
        createdAt: existing.createdAt.toISOString(),
        windowStart: existing.windowStart.toISOString(),
        windowEnd: existing.windowEnd.toISOString(),
        message: existing.message,
        metadata: existing.metadata,
      });
      return existing;
    }

    const tips =
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as any).tips
        : undefined;
    const tipsCount = Array.isArray(tips) ? tips.length : 0;
    console.log(
      `[FeedbackService] createFeedback type=${payload.type} severity=${payload.severity} meetingId=${payload.meetingId} participantId=${payload.participantId} message="${payload.message}" tipsCount=${tipsCount}`,
    );

    // Phase 6: broadcast first (realtime path), persist asynchronously (DB latency off hot path).
    const feedbackId = randomUUID();
    const createdAt = new Date();
    const room = `feedback:${payload.meetingId}`;
    const tBroadcastStartMs = Date.now();
    console.log(
      `[FeedbackService] broadcastFeedback (before persist) room=${room} type=${payload.type} severity=${payload.severity} windowEndToIngressMs=${windowEndToIngressMs}`,
    );
    this.feedbackGateway.broadcastFeedback(room, {
      id: feedbackId,
      meetingId: payload.meetingId,
      participantId: payload.participantId,
      type: payload.type,
      severity: payload.severity,
      ts: payload.ts.toISOString(),
      createdAt: createdAt.toISOString(),
      windowStart: payload.windowStart.toISOString(),
      windowEnd: payload.windowEnd.toISOString(),
      message: payload.message,
      metadata: (payload.metadata || {}) as Record<string, unknown>,
    });
    const tBroadcastEndMs = Date.now();
    const broadcastMs = tBroadcastEndMs - tBroadcastStartMs;
    const windowEndToBroadcastEmitMs = tBroadcastEndMs - windowEndMs;
    console.log(
      `[FeedbackService] broadcasted feedbackId=${feedbackId} broadcastMs=${broadcastMs} windowEndToBroadcastEmitMs=${windowEndToBroadcastEmitMs}`,
    );

    this.persistFeedbackAsync(payload, feedbackId, createdAt);

    return {
      id: feedbackId,
      meetingId: payload.meetingId,
      participantId: payload.participantId,
      type: payload.type,
      severity: payload.severity,
      ts: payload.ts,
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
      message: payload.message,
      metadata: (payload.metadata || {}) as Prisma.JsonValue,
      createdAt,
      expiresAt: null,
    } as FeedbackEvent;
  }

  private persistFeedbackAsync(
    payload: FeedbackPayload,
    feedbackId: string,
    createdAt: Date,
  ): void {
    const tPersistStartMs = Date.now();
    void (
      this.prisma as unknown as {
        feedbackEvent: {
          create: (args: { data: unknown }) => Promise<FeedbackEvent>;
        };
      }
    ).feedbackEvent
      .create({
        data: {
          id: feedbackId,
          meetingId: payload.meetingId,
          participantId: payload.participantId,
          type: payload.type,
          severity: payload.severity,
          ts: payload.ts,
          windowStart: payload.windowStart,
          windowEnd: payload.windowEnd,
          message: payload.message,
          metadata: (payload.metadata || {}) as Prisma.InputJsonValue,
          createdAt,
        },
      })
      .then(() => {
        const persistMs = Date.now() - tPersistStartMs;
        console.log(
          `[FeedbackService] async persist ok id=${feedbackId} persistMs=${persistMs} windowEnd=${payload.windowEnd.toISOString()}`,
        );
      })
      .catch((err: unknown) => {
        console.error(
          `[FeedbackService] async persist FAILED id=${feedbackId} meetingId=${payload.meetingId}`,
          err,
        );
      });
  }

  async getFeedbackMetrics(meetingId: string) {
    // PrismaService extends PrismaClient, so it has all PrismaClient methods
    const feedbacks = await (
      this.prisma as unknown as {
        feedbackEvent: {
          findMany: (args: {
            where: { meetingId: string };
            select: { type: boolean; severity: boolean };
          }) => Promise<
            Array<{ type: FeedbackType; severity: FeedbackSeverity }>
          >;
        };
      }
    ).feedbackEvent.findMany({
      where: {
        meetingId,
      },
      select: {
        type: true,
        severity: true,
      },
    });

    const counts: Record<string, number> = {};
    for (const feedback of feedbacks) {
      const key = feedback.type;
      counts[key] = (counts[key] || 0) + 1;
    }

    // Recent rows for HTTP polling clients (fallback when Socket.IO missed; with REDIS_URL broadcast is cross-replica)
    const recentRows = await (
      this.prisma as unknown as {
        feedbackEvent: {
          findMany: (args: {
            where: { meetingId: string };
            orderBy: { createdAt: 'desc' };
            take: number;
            select: {
              id: true;
              type: true;
              severity: true;
              ts: true;
              createdAt: true;
              message: true;
              metadata: true;
            };
          }) => Promise<
            Array<{
              id: string;
              type: FeedbackType;
              severity: FeedbackSeverity;
              ts: Date;
              createdAt: Date;
              message: string;
              metadata: Prisma.JsonValue;
            }>
          >;
        };
      }
    ).feedbackEvent.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        id: true,
        type: true,
        severity: true,
        ts: true,
        createdAt: true,
        message: true,
        metadata: true,
      },
    });

    const recent = recentRows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      ts: r.ts.toISOString(),
      createdAt: r.createdAt.toISOString(),
      message: r.message,
      metadata: r.metadata as Record<string, unknown> | null,
    }));

    return {
      meetingId,
      counts,
      total: feedbacks.length,
      recent,
    };
  }
}
