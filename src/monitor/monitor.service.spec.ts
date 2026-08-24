import { MonitorService } from './monitor.service';

describe('MonitorService', () => {
  const build = () => {
    const alerts: Array<{
      id: string;
      tenantId: string;
      meetingId: string;
      kind: string;
      message: string;
      createdAt: Date;
    }> = [];
    const prisma = {
      monitorAlert: {
        findFirst: jest.fn(async (args: { where: { kind?: string } }) => {
          const kind = args.where.kind;
          return (
            alerts.find(
              (row) =>
                row.kind === kind &&
                Date.now() - row.createdAt.getTime() < 60_000,
            ) ?? null
          );
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: `alert-${alerts.length + 1}`,
            tenantId: String(data.tenantId),
            meetingId: String(data.meetingId),
            kind: String(data.kind),
            message: String(data.message),
            createdAt: new Date(),
          };
          alerts.push(row);
          return row;
        }),
      },
    };
    const snapshots = {
      set: jest.fn(async () => undefined),
      publishFeedbackBroadcast: jest.fn(
        async (_input: { tenantId: string; meetingId: string; text: string }) =>
          undefined,
      ),
    };
    const gateway = {
      broadcastSnapshot: jest.fn(),
      broadcastAlert: jest.fn(),
      broadcastMeetingEnded: jest.fn(),
    };
    const feedback = { createFeedback: jest.fn(async () => ({ id: 'fb-1' })) };
    const service = new MonitorService(
      prisma as never,
      snapshots as never,
      gateway as never,
      feedback as never,
    );
    return { service, snapshots, gateway, feedback, alerts };
  };

  it('ingests a snapshot, caches it, and broadcasts', async () => {
    const { service, snapshots, gateway } = build();
    const snap = await service.ingestSnapshot({
      tenant_id: 't1',
      meeting_id: 'm1',
      health_score: 82,
      talk_listen_json: JSON.stringify({
        hostSpeechMs: 1000,
        customerSpeechMs: 2000,
        hostRatio: 0.33,
        factors: ['interesse alto'],
      }),
      objections_json: JSON.stringify({ active: [], resolved: [] }),
      playbook_adherence_json: JSON.stringify({
        percent: 25,
        faseSpin: 'situacao',
        steps: [],
      }),
      sentiment_trend_json: JSON.stringify({
        current: 'positivo',
        trend: 'estavel',
      }),
      alerts_json: '[]',
      ts_ms: 1,
    });
    expect(snap.healthScore).toBe(82);
    expect(snap.healthBand).toBe('green');
    expect(snap.healthFactors).toEqual(['interesse alto']);
    expect(snapshots.set).toHaveBeenCalled();
    expect(gateway.broadcastSnapshot).toHaveBeenCalledWith('t1', snap);
  });

  it('cools down yellow alerts but always stores SOS', async () => {
    const { service, gateway, alerts } = build();
    await service.createAlert({
      tenantId: 't1',
      meetingId: 'm1',
      kind: 'yellow',
      message: 'monologue',
    });
    await service.createAlert({
      tenantId: 't1',
      meetingId: 'm1',
      kind: 'yellow',
      message: 'monologue again',
    });
    expect(alerts.filter((a) => a.kind === 'yellow')).toHaveLength(1);

    await service.reportSos({ tenantId: 't1', meetingId: 'm1', userId: 'u1' });
    await service.reportSos({ tenantId: 't1', meetingId: 'm1', userId: 'u1' });
    expect(alerts.filter((a) => a.kind === 'sos')).toHaveLength(2);
    expect(gateway.broadcastAlert).toHaveBeenCalled();
  });

  it('persists whisper and dual-path broadcasts', async () => {
    const { service, feedback, snapshots } = build();
    const result = await service.sendWhisper({
      tenantId: 't1',
      meetingId: 'm1',
      actorUserId: 'mgr',
      message: 'Faz a pergunta de implicação',
    });
    expect(result.meetingId).toBe('m1');
    expect(feedback.createFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'manager_whisper',
        message: 'Faz a pergunta de implicação',
      }),
    );
    expect(snapshots.publishFeedbackBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', meetingId: 'm1' }),
    );
    // Ambos os caminhos (Socket.IO e Redis→FeedbackHub) carregam o MESMO id,
    // senão o dedup por payload.id no overlay não funciona.
    expect(result.id).toBe('fb-1');
    const [broadcastCall] = snapshots.publishFeedbackBroadcast.mock.calls[0];
    const envelope = JSON.parse(broadcastCall.text) as {
      payload: { id: string };
    };
    expect(envelope.payload.id).toBe('fb-1');
  });
});
