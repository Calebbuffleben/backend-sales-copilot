import { TextAnalysisFeedbackService } from './text-analysis-feedback.service';
import { MeetingStateStore } from './state-store';
import { ParticipantContextProvider } from './context-provider';
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
    text: 'Nao sei ainda, preciso avaliar melhor.',
    confidence: 0.82,
    rawFeedbackType: 'text_analysis_ingress',
    rawSeverity: 'info',
    rawMessage: 'Text analysis ingress event',
    analysis: {
      embedding: [],
      keywords: ['avaliar'],
      speechAct: 'statement',
      salesCategory: 'client_indecision',
      salesCategoryConfidence: 0.3,
      categoryIntensity: 0.46,
      categoryAmbiguity: 0.7,
      categoryFlags: {},
      conditionalKeywordsDetected: [],
      indecisionMetrics: undefined,
      samplesCount: 100,
      speechCount: 20,
      meanRmsDbfs: -24,
      analysisMode: 'semantic_suppressed',
      degradationLevel: 'L2',
      signalValidity: {
        indecision_fast: false,
        indecision_semantic: false,
        audio_aggregate: false,
      },
      suppressionReasons: ['indecision_fast_suppressed_by_severe_degradation'],
    },
    ...overrides,
  };
}

describe('TextAnalysisFeedbackService', () => {
  it('suppresses detectors whose required signal is invalid', async () => {
    const feedbackService = {
      createFeedback: jest.fn(),
    };
    const meetingStateStore = new MeetingStateStore();
    const contextProvider = new ParticipantContextProvider(meetingStateStore);
    const service = new TextAnalysisFeedbackService(
      meetingStateStore,
      contextProvider,
      feedbackService as never,
    );

    const feedbacks = await service.handleIngress(buildEvent());

    expect(feedbacks).toEqual([]);
    expect(feedbackService.createFeedback).not.toHaveBeenCalled();
  });

  it('keeps indecision eligible on fast path when only semantic enrichment is suppressed', async () => {
    const feedbackService = {
      createFeedback: jest.fn().mockResolvedValue({ id: 'feedback-1' }),
    };
    const meetingStateStore = new MeetingStateStore();
    const contextProvider = new ParticipantContextProvider(meetingStateStore);
    const service = new TextAnalysisFeedbackService(
      meetingStateStore,
      contextProvider,
      feedbackService as never,
    );

    const feedbacks = await service.handleIngress(
      buildEvent({
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
          signalValidity: {
            indecision_fast: true,
            indecision_semantic: false,
            audio_aggregate: false,
          },
          suppressionReasons: ['indecision_semantic_suppressed_by_degradation'],
        },
      }),
    );

    expect(feedbackService.createFeedback).toHaveBeenCalledTimes(1);
    expect(feedbacks).toHaveLength(1);
  });
});
