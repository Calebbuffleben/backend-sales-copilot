import { Injectable } from '@nestjs/common';

import type {
  MeetingFeedbackState,
  ParticipantFeedbackState,
  TextAnalysisIngressEvent,
} from './types';

const MAX_TEXT_HISTORY = 50;
const MAX_SAMPLES_HISTORY = 240;

function shouldRecordTextHistory(event: TextAnalysisIngressEvent): boolean {
  if (event.analysis.analysisMode === 'audio_only') {
    return false;
  }

  return (
    event.text.trim().length > 0 ||
    Boolean(event.analysis.salesCategory) ||
    Object.keys(event.analysis.categoryFlags).length > 0 ||
    Boolean(event.analysis.indecisionMetrics)
  );
}

@Injectable()
export class MeetingStateStore {
  private readonly stateByMeeting = new Map<string, MeetingFeedbackState>();

  getMeetingState(meetingId: string): MeetingFeedbackState {
    let state = this.stateByMeeting.get(meetingId);
    if (!state) {
      state = {
        meetingId,
        byParticipant: {},
        samples: [],
      };
      this.stateByMeeting.set(meetingId, state);
    }

    return state;
  }

  getParticipantState(
    meetingId: string,
    participantId: string,
  ): ParticipantFeedbackState {
    const meetingState = this.getMeetingState(meetingId);
    if (!meetingState.byParticipant[participantId]) {
      meetingState.byParticipant[participantId] = {
        participantId,
        textAnalysis: {
          textHistory: [],
        },
        cooldowns: {},
      };
    }

    return meetingState.byParticipant[participantId];
  }

  recordIngress(event: TextAnalysisIngressEvent): MeetingFeedbackState {
    const meetingState = this.getMeetingState(event.meetingId);
    const participantState = this.getParticipantState(
      event.meetingId,
      event.participantId,
    );

    if (event.participantName) {
      participantState.participantName = event.participantName;
    }
    if (event.participantRole) {
      participantState.participantRole = event.participantRole;
    }

    if (shouldRecordTextHistory(event)) {
      participantState.textAnalysis.textHistory.push({
        text: event.text,
        timestampMs: event.timestamp.getTime(),
        salesCategory: event.analysis.salesCategory,
        salesCategoryConfidence: event.analysis.salesCategoryConfidence,
        categoryIntensity: event.analysis.categoryIntensity,
        categoryFlags: event.analysis.categoryFlags,
        speechAct: event.analysis.speechAct,
        indecisionMetrics: event.analysis.indecisionMetrics,
        conditionalKeywordsDetected: event.analysis.conditionalKeywordsDetected,
      });
      if (participantState.textAnalysis.textHistory.length > MAX_TEXT_HISTORY) {
        participantState.textAnalysis.textHistory.splice(
          0,
          participantState.textAnalysis.textHistory.length - MAX_TEXT_HISTORY,
        );
      }
    }

    const sampleTimestampMs = event.timestamp.getTime();
    const existingSample = meetingState.samples.find(
      (sample) =>
        sample.participantId === event.participantId &&
        sample.timestampMs === sampleTimestampMs,
    );
    if (existingSample) {
      existingSample.samplesCount = event.analysis.samplesCount ?? 0;
      existingSample.speechCount = event.analysis.speechCount ?? 0;
      existingSample.meanRmsDbfs = event.analysis.meanRmsDbfs;
    } else {
      meetingState.samples.push({
        participantId: event.participantId,
        timestampMs: sampleTimestampMs,
        samplesCount: event.analysis.samplesCount ?? 0,
        speechCount: event.analysis.speechCount ?? 0,
        meanRmsDbfs: event.analysis.meanRmsDbfs,
      });
    }
    if (meetingState.samples.length > MAX_SAMPLES_HISTORY) {
      meetingState.samples.splice(
        0,
        meetingState.samples.length - MAX_SAMPLES_HISTORY,
      );
    }

    return meetingState;
  }
}
