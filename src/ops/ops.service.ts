import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

@Injectable()
export class OpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  liveMeetings() {
    return this.tenantCtx.runWithTenantBypass(async () =>
      this.prisma.session.findMany({
        where: {
          OR: [
            { status: 'ACTIVE' },
            { activeConnections: { gt: 0 } },
            { lastSeenAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
          ],
        },
        orderBy: { lastSeenAt: 'desc' },
        include: {
          tenant: { select: { id: true, slug: true, name: true } },
        },
        take: 100,
      }),
    );
  }

  meeting(meetingId: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const sessions = await this.prisma.session.findMany({
        where: { meetingId },
        include: { tenant: { select: { id: true, slug: true, name: true } } },
        orderBy: { lastSeenAt: 'desc' },
      });
      const [feedbacks, events] = await Promise.all([
        this.prisma.feedbackEvent.findMany({
          where: { meetingId },
          orderBy: { ts: 'desc' },
          take: 100,
        }),
        this.prisma.operationalEvent.findMany({
          where: { meetingId },
          orderBy: { timestamp: 'desc' },
          take: 200,
        }),
      ]);
      return { sessions, feedbacks, events };
    });
  }

  meetingsToday() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const start = startOfDay(new Date());
      const [count, audio] = await Promise.all([
        this.prisma.session.count({ where: { startedAt: { gte: start } } }),
        this.prisma.session.aggregate({
          where: { startedAt: { gte: start } },
          _sum: { audioSeconds: true },
        }),
      ]);
      return {
        meetingsToday: count,
        audioSeconds: audio._sum.audioSeconds ?? 0,
      };
    });
  }

  pipelineSummary() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const since = new Date(Date.now() - 60_000);
      const [received, processed, active] = await Promise.all([
        this.prisma.operationalEvent.count({
          where: { stage: 'transcription.received', timestamp: { gte: since } },
        }),
        this.prisma.operationalEvent.count({
          where: { stage: 'transcription.processed', timestamp: { gte: since } },
        }),
        this.prisma.session.count({
          where: { activeConnections: { gt: 0 } },
        }),
      ]);
      return {
        chunksReceivedPerSecond: received / 60,
        chunksProcessedPerSecond: processed / 60,
        currentQueue: active,
        averageLatencyMs: null,
      };
    });
  }

  aiSummary() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const since = new Date(Date.now() - 60_000);
      const [requests, errors, rateLimits] = await Promise.all([
        this.prisma.operationalEvent.count({
          where: { stage: 'gemini.started', timestamp: { gte: since } },
        }),
        this.prisma.operationalEvent.count({
          where: {
            stage: { startsWith: 'gemini.' },
            severity: { in: ['error', 'warning'] },
            timestamp: { gte: since },
          },
        }),
        this.prisma.operationalEvent.count({
          where: { stage: 'gemini.rate_limited', timestamp: { gte: since } },
        }),
      ]);
      const avg = await this.prisma.operationalEvent.aggregate({
        where: {
          stage: 'gemini.finished',
          durationMs: { not: null },
          timestamp: { gte: since },
        },
        _avg: { durationMs: true },
      });
      return {
        geminiRequestsPerMinute: requests,
        averageResponseMs: avg._avg.durationMs ?? null,
        errors,
        rateLimitEvents: rateLimits,
      };
    });
  }

  recentFeedbacks(limit = 100) {
    return this.tenantCtx.runWithTenantBypass(async () =>
      this.prisma.feedbackEvent.findMany({
        orderBy: { ts: 'desc' },
        take: Math.min(Math.max(limit, 1), 200),
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      }),
    );
  }

  logs(query: {
    meetingId?: string;
    tenantId?: string;
    userId?: string;
    q?: string;
    limit?: number;
  }) {
    return this.tenantCtx.runWithTenantBypass(async () =>
      this.prisma.operationalEvent.findMany({
        where: {
          meetingId: query.meetingId,
          tenantId: query.tenantId,
          userId: query.userId,
          ...(query.q
            ? {
                OR: [
                  { message: { contains: query.q, mode: 'insensitive' } },
                  { stage: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { timestamp: 'desc' },
        take: Math.min(Math.max(query.limit ?? 100, 1), 500),
      }),
    );
  }

  saasSummary() {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const start = startOfDay(new Date());
      const [
        activeTenants,
        activeUsers,
        meetingsToday,
        audio,
        feedbacks,
        subscriptions,
      ] = await Promise.all([
        this.prisma.tenant.count({ where: { status: 'ACTIVE' } }),
        this.prisma.user.count({ where: { isActive: true } }),
        this.prisma.session.count({ where: { startedAt: { gte: start } } }),
        this.prisma.session.aggregate({
          where: { startedAt: { gte: start } },
          _sum: { audioSeconds: true },
        }),
        this.prisma.feedbackEvent.count({ where: { createdAt: { gte: start } } }),
        this.prisma.subscription.groupBy({
          by: ['plan'],
          _count: { _all: true },
        }),
      ]);
      return {
        activeTenants,
        activeUsers,
        meetingsToday,
        processedHours: (audio._sum.audioSeconds ?? 0) / 3600,
        feedbacksToday: feedbacks,
        geminiCostUsd: 0,
        assemblyAiCostUsd: 0,
        estimatedMonthlyRevenueUsd: estimateRevenue(subscriptions),
      };
    });
  }
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function estimateRevenue(groups: Array<{ plan: string; _count: { _all: number } }>) {
  const prices: Record<string, number> = { FREE: 0, PRO: 49, ENTERPRISE: 199 };
  return groups.reduce((sum, row) => sum + (prices[row.plan] ?? 0) * row._count._all, 0);
}
