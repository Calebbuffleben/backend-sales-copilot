import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { MonitorAlertKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackService } from '../feedback/feedback.service';
import { MonitorGateway } from './monitor.gateway';
import { MonitorSnapshotStore } from './monitor.snapshot-store';
import {
  healthBandFromScore,
  type MeetingSnapshot,
} from './monitor.types';

const LIVE_WINDOW_MS = 5 * 60 * 1000;

@Injectable()
export class MonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: MonitorSnapshotStore,
    private readonly monitorGateway: MonitorGateway,
    @Inject(forwardRef(() => FeedbackService))
    private readonly feedbackService: FeedbackService,
  ) {}

  async ingestSnapshot(raw: {
    tenant_id?: string;
    meeting_id?: string;
    health_score?: number;
    talk_listen_json?: string;
    objections_json?: string;
    playbook_adherence_json?: string;
    sentiment_trend_json?: string;
    alerts_json?: string;
    ts_ms?: number | string;
  }): Promise<MeetingSnapshot> {
    const tenantId = String(raw.tenant_id || '').trim();
    const meetingId = String(raw.meeting_id || '').trim();
    if (!tenantId || !meetingId) {
      throw new Error('tenant_id and meeting_id are required');
    }
    const healthScore = clampScore(Number(raw.health_score ?? 50));
    const snapshot: MeetingSnapshot = {
      meetingId,
      tenantId,
      healthScore,
      healthBand: healthBandFromScore(healthScore),
      healthFactors: [],
      talkListen: parseTalkListen(raw.talk_listen_json),
      objections: parseObjections(raw.objections_json),
      playbookAdherence: parsePlaybook(raw.playbook_adherence_json),
      sentiment: parseSentiment(raw.sentiment_trend_json),
      alerts: parseAlerts(raw.alerts_json),
      tsMs: Number(raw.ts_ms || Date.now()),
    };
    const adherence = snapshot.playbookAdherence;
    snapshot.healthFactors = parseHealthFactors(raw.talk_listen_json, snapshot);

    await this.snapshots.set(snapshot);
    this.monitorGateway.broadcastSnapshot(tenantId, snapshot);

    for (const alert of snapshot.alerts) {
      await this.createAlert({
        tenantId,
        meetingId,
        kind: alert.kind,
        message: alert.message,
        metadata: { source: 'python', healthScore, faseSpin: adherence.faseSpin },
      });
    }
    return snapshot;
  }

  async liveMeetings(tenantId: string) {
    const sessions = await this.prisma.session.findMany({
      where: {
        tenantId,
        OR: [
          { status: 'ACTIVE' },
          { activeConnections: { gt: 0 } },
          { lastSeenAt: { gte: new Date(Date.now() - LIVE_WINDOW_MS) } },
        ],
      },
      orderBy: { lastSeenAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      take: 100,
    });
    const snaps = await this.snapshots.getMany(
      tenantId,
      sessions.map((s) => s.meetingId),
    );
    return sessions.map((session) => ({
      meetingId: session.meetingId,
      status: session.status,
      startedAt: session.startedAt,
      lastSeenAt: session.lastSeenAt,
      durationMs: Date.now() - session.startedAt.getTime(),
      activeConnections: session.activeConnections,
      rep: session.user
        ? {
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          }
        : null,
      snapshot: snaps.get(session.meetingId) ?? null,
    }));
  }

  async meetingDetail(tenantId: string, meetingId: string) {
    const session = await this.prisma.session.findUnique({
      where: { tenantId_meetingId: { tenantId, meetingId } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!session) {
      throw new NotFoundException('Meeting not found');
    }
    const [feedbacks, alerts, snapshot] = await Promise.all([
      this.prisma.feedbackEvent.findMany({
        where: { tenantId, meetingId },
        orderBy: { ts: 'desc' },
        take: 80,
      }),
      this.prisma.monitorAlert.findMany({
        where: { tenantId, meetingId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.snapshots.get(tenantId, meetingId),
    ]);
    return {
      session: {
        meetingId: session.meetingId,
        status: session.status,
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
        durationMs: Date.now() - session.startedAt.getTime(),
        activeConnections: session.activeConnections,
        rep: session.user
          ? {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
            }
          : null,
      },
      snapshot,
      feedbacks: feedbacks.reverse(),
      alerts,
    };
  }

  async listAlerts(tenantId: string, since?: Date) {
    return this.prisma.monitorAlert.findMany({
      where: {
        tenantId,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async acknowledgeAlert(tenantId: string, alertId: string, userId: string) {
    const alert = await this.prisma.monitorAlert.findFirst({
      where: { id: alertId, tenantId },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    return this.prisma.monitorAlert.update({
      where: { id: alertId },
      data: { acknowledgedAt: new Date(), acknowledgedBy: userId },
    });
  }

  async sendWhisper(input: {
    tenantId: string;
    meetingId: string;
    actorUserId: string;
    message: string;
  }) {
    const now = new Date();
    const payload = {
      tenantId: input.tenantId,
      meetingId: input.meetingId,
      participantId: input.actorUserId,
      type: 'manager_whisper' as const,
      severity: 'critical' as const,
      ts: now,
      windowStart: now,
      windowEnd: now,
      message: input.message,
      metadata: {
        source: 'manager',
        actorUserId: input.actorUserId,
      },
    };
    // Reuse the Socket.IO broadcast id in the Redis envelope so the overlay
    // dedups the whisper when both delivery paths arrive (dedup by payload.id).
    const event = await this.feedbackService.createFeedback(payload);
    const id = event.id;

    const envelope = {
      type: 'feedback',
      payload: {
        id,
        tenantId: input.tenantId,
        meetingId: input.meetingId,
        participantId: input.actorUserId,
        type: 'manager_whisper',
        severity: 'critical',
        ts: now.getTime(),
        message: input.message,
        metadata: payload.metadata,
      },
    };
    await this.snapshots.publishFeedbackBroadcast({
      tenantId: input.tenantId,
      meetingId: input.meetingId,
      text: JSON.stringify(envelope),
    });
    return { id, meetingId: input.meetingId };
  }

  async reportSos(input: {
    tenantId: string;
    meetingId: string;
    userId: string;
  }) {
    const alert = await this.createAlert({
      tenantId: input.tenantId,
      meetingId: input.meetingId,
      kind: 'sos',
      message: 'Vendedor pediu ajuda (SOS)',
      metadata: { userId: input.userId },
    });
    return alert;
  }

  async createAlert(input: {
    tenantId: string;
    meetingId: string;
    kind: 'red' | 'yellow' | 'sos';
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const kind = input.kind as MonitorAlertKind;
    const recent = await this.prisma.monitorAlert.findFirst({
      where: {
        tenantId: input.tenantId,
        meetingId: input.meetingId,
        kind,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
    });
    if (recent && input.kind !== 'sos') {
      return recent;
    }
    const alert = await this.prisma.monitorAlert.create({
      data: {
        tenantId: input.tenantId,
        meetingId: input.meetingId,
        kind,
        message: input.message,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    this.monitorGateway.broadcastAlert(input.tenantId, {
      id: alert.id,
      meetingId: alert.meetingId,
      kind: input.kind,
      message: alert.message,
      createdAt: alert.createdAt.toISOString(),
    });
    return alert;
  }

  notifyMeetingEnded(tenantId: string, meetingId: string) {
    this.monitorGateway.broadcastMeetingEnded(tenantId, meetingId);
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseJson(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTalkListen(raw: string | undefined): MeetingSnapshot['talkListen'] {
  const v = parseJson(raw) as Record<string, unknown> | null;
  return {
    hostSpeechMs: Number(v?.hostSpeechMs ?? 0) || 0,
    customerSpeechMs: Number(v?.customerSpeechMs ?? 0) || 0,
    hostRatio: Number(v?.hostRatio ?? 0) || 0,
    hostRatioRecent: Number(v?.hostRatioRecent ?? 0) || 0,
    hostMonologueMs: Number(v?.hostMonologueMs ?? 0) || 0,
  };
}

function parseObjections(raw: string | undefined): MeetingSnapshot['objections'] {
  const v = parseJson(raw) as Record<string, unknown> | null;
  return {
    active: Array.isArray(v?.active) ? v.active.map(String) : [],
    resolved: Array.isArray(v?.resolved) ? v.resolved.map(String) : [],
  };
}

function parsePlaybook(
  raw: string | undefined,
): MeetingSnapshot['playbookAdherence'] {
  const v = parseJson(raw) as Record<string, unknown> | null;
  const steps = Array.isArray(v?.steps)
    ? (v.steps as Array<Record<string, unknown>>).map((s, i) => ({
        id: String(s.id ?? i),
        label: String(s.label ?? `Step ${i + 1}`),
        done: Boolean(s.done),
      }))
    : [];
  return {
    percent: Number(v?.percent ?? 0) || 0,
    faseSpin: String(v?.faseSpin ?? 'neutro'),
    steps,
  };
}

function parseSentiment(raw: string | undefined): MeetingSnapshot['sentiment'] {
  const v = parseJson(raw) as Record<string, unknown> | null;
  return {
    current: String(v?.current ?? 'neutro'),
    trend: String(v?.trend ?? 'estavel'),
  };
}

function parseAlerts(
  raw: string | undefined,
): MeetingSnapshot['alerts'] {
  const v = parseJson(raw);
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const kind = rec.kind;
      if (kind !== 'red' && kind !== 'yellow' && kind !== 'sos') return null;
      return { kind, message: String(rec.message ?? '') };
    })
    .filter((item): item is MeetingSnapshot['alerts'][number] => Boolean(item));
}

function parseHealthFactors(
  talkRaw: string | undefined,
  snapshot: MeetingSnapshot,
): string[] {
  const v = parseJson(talkRaw) as Record<string, unknown> | null;
  if (Array.isArray(v?.factors) && v.factors.length) {
    return v.factors.map(String);
  }
  const factors: string[] = [];
  if (snapshot.healthBand === 'red') factors.push('saúde crítica');
  if (snapshot.objections.active.length)
    factors.push(`${snapshot.objections.active.length} objeção(ões) ativas`);
  if (snapshot.talkListen.hostRatio >= 0.7) factors.push('vendedor falando demais');
  if (snapshot.sentiment.trend === 'caindo') factors.push('sentimento caindo');
  return factors;
}
