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
    const tips =
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as any).tips
        : undefined;
    const tipsCount = Array.isArray(tips) ? tips.length : 0;
    console.log(
      `[FeedbackService] createFeedback type=${payload.type} severity=${payload.severity} meetingId=${payload.meetingId} participantId=${payload.participantId} message="${payload.message}" tipsCount=${tipsCount}`,
    );
    // Save to database
    // PrismaService extends PrismaClient, so it has all PrismaClient methods
    const feedback = await (
      this.prisma as unknown as {
        feedbackEvent: {
          create: (args: { data: unknown }) => Promise<FeedbackEvent>;
        };
      }
    ).feedbackEvent.create({
      data: {
        meetingId: payload.meetingId,
        participantId: payload.participantId,
        type: payload.type,
        severity: payload.severity,
        ts: payload.ts,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
        message: payload.message,
        metadata: (payload.metadata || {}) as Prisma.InputJsonValue,
      },
    });

    console.log(
      `[FeedbackService] persisted feedback id=${feedback.id} windowStart=${feedback.windowStart.toISOString()} windowEnd=${feedback.windowEnd.toISOString()}`,
    );

    // Broadcast to Socket.IO room
    const room = `feedback:${payload.meetingId}`;
    console.log(
      `[FeedbackService] broadcastFeedback room=${room} type=${feedback.type} severity=${feedback.severity}`,
    );
    this.feedbackGateway.broadcastFeedback(room, {
      id: feedback.id,
      meetingId: feedback.meetingId,
      participantId: feedback.participantId,
      type: feedback.type,
      severity: feedback.severity,
      ts: feedback.ts.toISOString(),
      createdAt: feedback.createdAt.toISOString(),
      windowStart: feedback.windowStart.toISOString(),
      windowEnd: feedback.windowEnd.toISOString(),
      message: feedback.message,
      metadata: feedback.metadata,
    });

    return feedback;
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

    // Recent rows for HTTP polling clients (Chrome overlay on Railway: Socket.IO rooms are in-memory
    // per replica, so broadcast may not reach the client on another instance; DB is always consistent.)
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
