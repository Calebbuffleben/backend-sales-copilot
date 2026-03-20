import { Injectable } from '@nestjs/common';

import { MeetingStateStore } from './state-store';
import type { FeedbackRuleContext, ParticipantRole } from './types';

@Injectable()
export class ParticipantContextProvider implements FeedbackRuleContext {
  constructor(private readonly meetingStateStore: MeetingStateStore) {}

  getParticipantRole(
    meetingId: string,
    participantId: string,
  ): ParticipantRole | null {
    const participantState = this.meetingStateStore.getParticipantState(
      meetingId,
      participantId,
    );
    return participantState.participantRole ?? null;
  }

  getParticipantName(meetingId: string, participantId: string): string | null {
    const participantState = this.meetingStateStore.getParticipantState(
      meetingId,
      participantId,
    );
    return participantState.participantName ?? null;
  }

  recordParticipantMetadata(
    meetingId: string,
    participantId: string,
    data: {
      participantName?: string;
      participantRole?: ParticipantRole;
    },
  ): void {
    const participantState = this.meetingStateStore.getParticipantState(
      meetingId,
      participantId,
    );

    if (data.participantName) {
      participantState.participantName = data.participantName;
    }
    if (data.participantRole) {
      participantState.participantRole = data.participantRole;
    }
  }
}
