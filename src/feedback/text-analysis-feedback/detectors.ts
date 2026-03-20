import { detectClientIndecision } from './detect-indecision-feedback';
import type { TextAnalysisDetector } from './types';

export function buildTextAnalysisDetectors(): TextAnalysisDetector[] {
  return [detectClientIndecision];
}
