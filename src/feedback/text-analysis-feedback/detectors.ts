import { detectClientIndecision } from './detect-indecision-feedback';
import type { TextAnalysisDetector } from './types';
import { detectConversationDominance } from '../audio-feedback/detect-conversation-dominance-feedback';

export function buildTextAnalysisDetectors(): TextAnalysisDetector[] {
  return [detectClientIndecision, detectConversationDominance];
}
