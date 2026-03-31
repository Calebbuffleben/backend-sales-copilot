import { detectClientIndecision } from './detect-indecision-feedback';
import type { TextAnalysisDetectorDefinition } from './types';
import { detectConversationDominance } from '../audio-feedback/detect-conversation-dominance-feedback';

export function buildTextAnalysisDetectors(): TextAnalysisDetectorDefinition[] {
  return [
    {
      name: 'detectClientIndecision',
      requiredSignals: ['semantic_indecision'],
      run: detectClientIndecision,
    },
    {
      name: 'detectConversationDominance',
      requiredSignals: ['audio_aggregate'],
      run: detectConversationDominance,
    },
  ];
}
