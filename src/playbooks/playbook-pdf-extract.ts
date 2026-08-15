import {
  PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS,
  PLAYBOOK_SOURCE_TEXT_MAX_CHARS,
} from './playbook-pdf.constants';

export type ExtractedPlaybookPdf = {
  sourceText: string;
  sourceTextExcerpt: string;
};

/**
 * Extract plain text from a PDF buffer (admin upload only).
 * Ceiling: text layer only; scanned PDFs need OCR upgrade later.
 */
export async function extractPlaybookPdfText(
  buffer: Buffer,
): Promise<ExtractedPlaybookPdf> {
  // pdf-parse v2 CJS API
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require('pdf-parse') as {
    PDFParse: new (opts: { data: Buffer | Uint8Array }) => {
      getText: () => Promise<{ text?: string }>;
      destroy: () => Promise<void>;
    };
  };
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const raw = (parsed.text || '').replace(/\s+/g, ' ').trim();
    const sourceText = raw.slice(0, PLAYBOOK_SOURCE_TEXT_MAX_CHARS);
    const sourceTextExcerpt = sourceText.slice(
      0,
      PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS,
    );
    return { sourceText, sourceTextExcerpt };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
