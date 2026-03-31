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
      analysisMode: 'full_semantic',
      degradationLevel: 'L0',
      signalValidity: {
        indecision_fast: true,
        indecision_semantic: true,
        audio_aggregate: true,
      },
      suppressionReasons: [],
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
      semanticStrong: true,
      persistentIndecision: false,
      fastConservative: false,
    });
    expect(payload?.metadata['signalPath']).toBe('semantic');
  });

  it('keeps emitting when semantic indecision persists across recent windows', () => {
    const firstEvent = buildEvent({
      timestamp: new Date('2026-03-18T20:13:44.410Z'),
      windowStart: new Date('2026-03-18T20:13:39.410Z'),
      windowEnd: new Date('2026-03-18T20:13:44.410Z'),
      text: 'Nao sei ainda, preciso avaliar melhor.',
      analysis: {
        ...buildEvent().analysis,
        categoryIntensity: 0.46,
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
      semanticStrong: true,
      persistentIndecision: true,
    });
    expect(payload?.metadata['representativePhrases']).toEqual(
      expect.arrayContaining([
        'Nao sei ainda, preciso avaliar melhor.',
        'Talvez funcione, mas ainda nao tenho certeza.',
      ]),
    );
  });

  it('emits on degraded fast path only when conservative lexical evidence is strong', () => {
    const event = buildEvent({
      text: 'Se nao der certo agora, vou pensar e te aviso depois.',
      analysis: {
        ...buildEvent().analysis,
        salesCategory: undefined,
        categoryIntensity: undefined,
        categoryFlags: {},
        conditionalKeywordsDetected: ['se'],
        indecisionMetrics: {
          conditionalLanguageScore: 0.8,
          postponementLikelihood: 0.75,
        },
        analysisMode: 'semantic_suppressed',
        degradationLevel: 'L2',
        signalValidity: {
          indecision_fast: true,
          indecision_semantic: false,
          audio_aggregate: true,
        },
        suppressionReasons: ['indecision_semantic_suppressed_by_degradation'],
      },
    });
    const meetingState = meetingStateStore.recordIngress(event);

    const payload = detectClientIndecision(
      meetingState,
      event,
      event.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).not.toBeNull();
    expect(payload?.metadata['signalPath']).toBe('fast');
    expect(payload?.metadata['ruleMatches']).toMatchObject({
      semanticStrong: false,
      semanticSupporting: false,
      persistentIndecision: false,
      fastConservative: true,
    });
  });

  it('does not emit for weak lexical evidence without semantic support', () => {
    const event = buildEvent({
      text: 'Talvez depois.',
      analysis: {
        ...buildEvent().analysis,
        salesCategory: undefined,
        categoryIntensity: undefined,
        categoryFlags: {},
        conditionalKeywordsDetected: [],
        indecisionMetrics: {
          conditionalLanguageScore: 0.0,
          postponementLikelihood: 0.6,
        },
        analysisMode: 'semantic_suppressed',
        degradationLevel: 'L2',
        signalValidity: {
          indecision_fast: true,
          indecision_semantic: false,
          audio_aggregate: true,
        },
        suppressionReasons: ['indecision_semantic_suppressed_by_degradation'],
      },
    });
    const meetingState = meetingStateStore.recordIngress(event);

    const payload = detectClientIndecision(
      meetingState,
      event,
      event.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).toBeNull();
  });
});
