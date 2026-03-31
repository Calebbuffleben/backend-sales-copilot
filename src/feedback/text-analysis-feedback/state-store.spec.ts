import { MeetingStateStore } from './state-store';
import type { TextAnalysisIngressEvent } from './types';

function buildEvent(
  overrides: Partial<TextAnalysisIngressEvent> = {},
): TextAnalysisIngressEvent {
  return {
    meetingId: 'meeting-1',
    participantId: 'participant-1',
    participantName: 'Cliente',
    participantRole: 'participant',
    timestamp: new Date('2026-03-31T12:00:00.000Z'),
    windowStart: new Date('2026-03-31T11:59:55.000Z'),
    windowEnd: new Date('2026-03-31T12:00:00.000Z'),
    text: '',
    confidence: 0,
    rawFeedbackType: 'audio_metrics_ingress',
    rawSeverity: 'info',
    rawMessage: 'Audio aggregate ingress event',
    analysis: {
      embedding: [],
      keywords: [],
      categoryFlags: {},
      conditionalKeywordsDetected: [],
      samplesCount: 100,
      speechCount: 70,
      meanRmsDbfs: -24,
      analysisMode: 'audio_only',
      degradationLevel: 'L0',
      signalValidity: {
        indecision_fast: false,
        indecision_semantic: false,
        audio_aggregate: true,
      },
      suppressionReasons: ['indecision_not_available_for_audio_only_ingress'],
    },
    ...overrides,
  };
}

describe('MeetingStateStore', () => {
  it('does not append text history for audio-only ingress and dedupes samples', () => {
    const store = new MeetingStateStore();
    const audioEvent = buildEvent();

    const firstState = store.recordIngress(audioEvent);
    expect(
      firstState.byParticipant[audioEvent.participantId].textAnalysis.textHistory,
    ).toHaveLength(0);
    expect(firstState.samples).toHaveLength(1);
    expect(firstState.samples[0]?.speechCount).toBe(70);

    const textEvent = buildEvent({
      rawFeedbackType: 'text_analysis_ingress',
      text: 'Nao sei ainda, preciso avaliar melhor.',
      confidence: 0.8,
      analysis: {
        ...audioEvent.analysis,
        analysisMode: 'full_semantic',
        salesCategory: 'client_indecision',
        salesCategoryConfidence: 0.2,
        categoryIntensity: 0.46,
        signalValidity: {
          indecision_fast: true,
          indecision_semantic: true,
          audio_aggregate: true,
        },
        suppressionReasons: [],
      },
    });
    const secondState = store.recordIngress(textEvent);

    expect(
      secondState.byParticipant[textEvent.participantId].textAnalysis.textHistory,
    ).toHaveLength(1);
    expect(secondState.samples).toHaveLength(1);
    expect(secondState.samples[0]?.speechCount).toBe(70);
  });
});
