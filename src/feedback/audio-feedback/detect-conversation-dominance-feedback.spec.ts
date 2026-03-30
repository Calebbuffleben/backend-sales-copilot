import { ParticipantContextProvider } from '../text-analysis-feedback/context-provider';
import { MeetingStateStore } from '../text-analysis-feedback/state-store';
import type { TextAnalysisIngressEvent } from '../text-analysis-feedback/types';
import { detectConversationDominance } from './detect-conversation-dominance-feedback';

function buildEvent(
  overrides: Partial<TextAnalysisIngressEvent> = {},
): TextAnalysisIngressEvent {
  return {
    meetingId: 'meeting-1',
    participantId: 'seller-1',
    participantName: 'Vendedor',
    participantRole: 'participant',
    timestamp: new Date('2026-03-30T10:00:00.000Z'),
    windowStart: new Date('2026-03-30T09:59:55.000Z'),
    windowEnd: new Date('2026-03-30T10:00:00.000Z'),
    text: 'Vamos continuar.',
    confidence: 0.8,
    rawFeedbackType: 'text_analysis_ingress',
    rawSeverity: 'info',
    rawMessage: 'Text analysis ingress event',
    analysis: {
      embedding: [],
      keywords: [],
      categoryFlags: {},
      conditionalKeywordsDetected: [],
      samplesCount: 16_000,
      speechCount: 13_000,
      meanRmsDbfs: -18,
    },
    ...overrides,
  };
}

describe('detectConversationDominance', () => {
  let meetingStateStore: MeetingStateStore;
  let contextProvider: ParticipantContextProvider;

  beforeEach(() => {
    meetingStateStore = new MeetingStateStore();
    contextProvider = new ParticipantContextProvider(meetingStateStore);
    process.env.SALES_CONVERSATION_DOMINANCE_LOOKBACK_MS = '60000';
    process.env.SALES_CONVERSATION_DOMINANCE_THRESHOLD = '0.7';
    process.env.SALES_CONVERSATION_DOMINANCE_MIN_MEETING_SPEECH_COUNT = '1000';
    process.env.SALES_CONVERSATION_DOMINANCE_COOLDOWN_MS = '120000';
  });

  afterEach(() => {
    delete process.env.SALES_CONVERSATION_DOMINANCE_LOOKBACK_MS;
    delete process.env.SALES_CONVERSATION_DOMINANCE_THRESHOLD;
    delete process.env.SALES_CONVERSATION_DOMINANCE_MIN_MEETING_SPEECH_COUNT;
    delete process.env.SALES_CONVERSATION_DOMINANCE_COOLDOWN_MS;
  });

  it('emits when current participant dominates meeting speech in lookback window', () => {
    const sellerEvent = buildEvent();
    meetingStateStore.recordIngress(sellerEvent);

    const otherEvent = buildEvent({
      participantId: 'client-1',
      participantName: 'Cliente',
      analysis: {
        ...sellerEvent.analysis,
        samplesCount: 16_000,
        speechCount: 4_000,
      },
    });
    const meetingState = meetingStateStore.recordIngress(otherEvent);

    const payload = detectConversationDominance(
      meetingState,
      sellerEvent,
      sellerEvent.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).not.toBeNull();
    expect(payload?.type).toBe('conversation_dominance');
    expect(payload?.severity).toBe('warning');
    expect(payload?.metadata['speechShare']).toBe(0.765);
    expect(payload?.metadata['meetingSpeechCount']).toBe(17_000);
  });

  it('does not emit when speech share stays below threshold', () => {
    const sellerEvent = buildEvent({
      analysis: {
        ...buildEvent().analysis,
        speechCount: 8_000,
      },
    });
    meetingStateStore.recordIngress(sellerEvent);

    const clientEvent = buildEvent({
      participantId: 'client-1',
      analysis: {
        ...buildEvent().analysis,
        speechCount: 7_000,
      },
    });
    const meetingState = meetingStateStore.recordIngress(clientEvent);

    const payload = detectConversationDominance(
      meetingState,
      sellerEvent,
      sellerEvent.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).toBeNull();
  });

  it('respects cooldown to avoid repeated feedback spam', () => {
    const sellerEvent = buildEvent();
    meetingStateStore.recordIngress(sellerEvent);
    const otherEvent = buildEvent({
      participantId: 'client-1',
      analysis: {
        ...sellerEvent.analysis,
        speechCount: 3_000,
      },
    });
    const meetingState = meetingStateStore.recordIngress(otherEvent);

    const firstPayload = detectConversationDominance(
      meetingState,
      sellerEvent,
      sellerEvent.timestamp.getTime(),
      contextProvider,
    );
    const secondPayload = detectConversationDominance(
      meetingState,
      sellerEvent,
      sellerEvent.timestamp.getTime() + 10_000,
      contextProvider,
    );

    expect(firstPayload).not.toBeNull();
    expect(secondPayload).toBeNull();
  });

  it('does not emit when meeting activity is below minimum speech count', () => {
    process.env.SALES_CONVERSATION_DOMINANCE_MIN_MEETING_SPEECH_COUNT = '50000';

    const sellerEvent = buildEvent({
      analysis: {
        ...buildEvent().analysis,
        speechCount: 11_000,
      },
    });
    meetingStateStore.recordIngress(sellerEvent);
    const otherEvent = buildEvent({
      participantId: 'client-1',
      analysis: {
        ...buildEvent().analysis,
        speechCount: 2_000,
      },
    });
    const meetingState = meetingStateStore.recordIngress(otherEvent);

    const payload = detectConversationDominance(
      meetingState,
      sellerEvent,
      sellerEvent.timestamp.getTime(),
      contextProvider,
    );

    expect(payload).toBeNull();
  });
});
