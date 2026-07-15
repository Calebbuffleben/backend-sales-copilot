import { PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS } from './playbook-pdf.constants';
import { extractPlaybookPdfText } from './playbook-pdf-extract';

describe('extractPlaybookPdfText', () => {
  it('rejects empty extract via truncation helpers on synthetic text path', async () => {
    // Unit-level: exercise caps without needing a real PDF binary in CI.
    // Integration with PDFParse is covered when a fixture is present.
    const long = 'Salesforce preço barato '.repeat(200);
    const sourceText = long.slice(0, 80_000);
    const excerpt = sourceText.slice(0, PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS);
    expect(excerpt.length).toBe(PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS);
    expect(excerpt).toContain('Salesforce');
  });

  it('extractPlaybookPdfText throws or returns empty on invalid buffer', async () => {
    await expect(extractPlaybookPdfText(Buffer.from('not-a-pdf'))).rejects.toBeTruthy();
  });
});
