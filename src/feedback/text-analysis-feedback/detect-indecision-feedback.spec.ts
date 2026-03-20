import { MeetingStateStore } from './state-store';
import { ParticipantContextProvider } from './context-provider';
import { detectClientIndecision } from './detect-indecision-feedback';
import type { TextAnalysisIngressEvent } from './types';

function buildEvent(
  overrides: Partial<TextAnalysisIngressEvent> = {},
): TextAnalysisIngressEvent {
  return {
    meetingId: 'meeting-1',
    participantId: 'participant-1',
    participantName: 'Cliente',
    participantRole: 'participant',
    timestamp: new Date('2026-03-18T20:13:44.410Z'),
    windowStart: new Date('2026-03-18T20:13:39.410Z'),
    windowEnd: new Date('2026-03-18T20:13:44.410Z'),
    text: 'Nao sei ainda, preciso avaliar melhor.',
    confidence: 0.7,
    rawFeedbackType: 'text_analysis_ingress',
    rawSeverity: 'info',
    rawMessage: 'Text analysis ingress event',
    analysis: {
      embedding: [],
      keywords: ['avaliar', 'melhor'],
      speechAct: 'statement',
      salesCategory: 'client_indecision',
      salesCategoryConfidence: 0.22,
      categoryIntensity: 0.46,
      categoryAmbiguity: 0.78,
      categoryFlags: {},
      conditionalKeywordsDetected: [],
      indecisionMetrics: undefined,
      samplesCount: 100,
      speechCount: 70,
      meanRmsDbfs: -24,
    },
    ...overrides,
  };
}

describe('detectClientIndecision', () => {
  let meetingStateStore: MeetingStateStore;
  let contextProvider: ParticipantContextProvider;

  beforeEach(() => {
    meetingStateStore = new MeetingStateStore();
    contextProvider = new ParticipantContextProvider(meetingStateStore);
  });

  it('emits feedback for semantic client_indecision evidence', () => {
    const event = buildEvent();
    const meetingState = meetingStateStore.recordIngress(event);

    const payload = detectClientIndecision(
      meetingState,
      event,
      event.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).not.toBeNull();
    expect(payload?.type).toBe('sales_client_indecision');
    expect(payload?.metadata['salesCategory']).toBe('client_indecision');
    expect(payload?.metadata['ruleMatches']).toMatchObject({
      semanticCategory: true,
      persistentIndecision: false,
    });
  });

  it('keeps emitting when semantic indecision persists across recent windows', () => {
    const firstEvent = buildEvent({
      timestamp: new Date('2026-03-18T20:13:44.410Z'),
      windowStart: new Date('2026-03-18T20:13:39.410Z'),
      windowEnd: new Date('2026-03-18T20:13:44.410Z'),
      text: 'Nao sei ainda, preciso avaliar melhor.',
      analysis: {
        ...buildEvent().analysis,
        categoryIntensity: 0.42,
      },
    });
    meetingStateStore.recordIngress(firstEvent);

    const secondEvent = buildEvent({
      timestamp: new Date('2026-03-18T20:13:49.410Z'),
      windowStart: new Date('2026-03-18T20:13:44.410Z'),
      windowEnd: new Date('2026-03-18T20:13:49.410Z'),
      text: 'Talvez funcione, mas ainda nao tenho certeza.',
    });
    const meetingState = meetingStateStore.recordIngress(secondEvent);

    const payload = detectClientIndecision(
      meetingState,
      secondEvent,
      secondEvent.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).not.toBeNull();
    expect(payload?.metadata['ruleMatches']).toMatchObject({
      semanticCategory: true,
      persistentIndecision: true,
    });
    expect(payload?.metadata['representativePhrases']).toEqual(
      expect.arrayContaining([
        'Nao sei ainda, preciso avaliar melhor.',
        'Talvez funcione, mas ainda nao tenho certeza.',
      ]),
    );
  });
});
