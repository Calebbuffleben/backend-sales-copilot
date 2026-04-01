import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackGateway } from './feedback.gateway';
import { logFeedbackTrace, makeFeedbackTraceId } from './feedback-trace';

// Import Prisma types from generated client
import type { Prisma } from '@prisma/client';
import type { FeedbackType, FeedbackSeverity } from '@prisma/client';

// FeedbackEvent type from Prisma
type FeedbackEvent = Prisma.FeedbackEventGetPayload<Record<string, never>>;

function metadataRecord(
  metadata: Record<string, unknown> | Prisma.JsonValue | null | undefined,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata as Record<string, unknown>;
}

function resolveFeedbackTraceId(
  meetingId: string,
  participantId: string,
  windowEndMs: number,
  metadata: Record<string, unknown>,
): string {
  const id = metadata['feedbackTraceId'];
  return typeof id === 'string' && id.length > 0
    ? id
    : makeFeedbackTraceId(meetingId, participantId, windowEndMs);
}

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

    const payloadMeta = metadataRecord(payload.metadata);

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
      const existingMeta = metadataRecord(
        existing.metadata as Prisma.JsonValue | null,
      );
      const traceId = resolveFeedbackTraceId(
        existing.meetingId,
        existing.participantId,
        windowEndMs,
        existingMeta,
      );
      // Still broadcast: ensures delivery even if retry happens before first emit.
      const room = `feedback:${existing.meetingId}`;
      const tBroadcastStartMs = Date.now();
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
      const tBroadcastEndMs = Date.now();
      const broadcastMs = tBroadcastEndMs - tBroadcastStartMs;
      const windowEndToBroadcastEmitMs = tBroadcastEndMs - windowEndMs;
      const detectorEventId = existingMeta['eventId'];
      logFeedbackTrace('backend.emit', {
        traceId,
        meetingId: existing.meetingId,
        participantId: existing.participantId,
        windowEndMs,
        feedbackType: existing.type,
        eventId:
          typeof detectorEventId === 'string' ? detectorEventId : existing.id,
        feedbackEmitId: existing.id,
        windowEndToBroadcastEmitMs,
        broadcastMs,
        windowEndToIngressMs,
        idempotentSkipCreate: true,
      });
      return existing;
    }

    // Phase 6: broadcast first (realtime path), persist asynchronously (DB latency off hot path).
    const feedbackId = randomUUID();
    const createdAt = new Date();
    const room = `feedback:${payload.meetingId}`;
    const traceId = resolveFeedbackTraceId(
      payload.meetingId,
      payload.participantId,
      windowEndMs,
      payloadMeta,
    );
    const tBroadcastStartMs = Date.now();
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
    const detectorEventId = payloadMeta['eventId'];
    logFeedbackTrace('backend.emit', {
      traceId,
      meetingId: payload.meetingId,
      participantId: payload.participantId,
      windowEndMs,
      feedbackType: payload.type,
      eventId:
        typeof detectorEventId === 'string' ? detectorEventId : feedbackId,
      feedbackEmitId: feedbackId,
      windowEndToBroadcastEmitMs,
      broadcastMs,
      windowEndToIngressMs,
      idempotentSkipCreate: false,
    });

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
