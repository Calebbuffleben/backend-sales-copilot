export type MeetingHealthBand = 'green' | 'yellow' | 'red';

export type MeetingSnapshot = {
  meetingId: string;
  tenantId: string;
  healthScore: number;
  healthBand: MeetingHealthBand;
  healthFactors: string[];
  talkListen: {
    hostSpeechMs: number;
    customerSpeechMs: number;
    hostRatio: number;
    /** Host ratio over the last ~2min moving window ("talkative right now"). */
    hostRatioRecent: number;
    hostMonologueMs: number;
  };
  objections: {
    active: string[];
    resolved: string[];
  };
  playbookAdherence: {
    percent: number;
    faseSpin: string;
    steps: Array<{ id: string; label: string; done: boolean }>;
  };
  sentiment: {
    current: string;
    trend: string;
  };
  alerts: Array<{
    kind: 'red' | 'yellow' | 'sos';
    message: string;
  }>;
  tsMs: number;
};

export function healthBandFromScore(score: number): MeetingHealthBand {
  if (score >= 70) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}
