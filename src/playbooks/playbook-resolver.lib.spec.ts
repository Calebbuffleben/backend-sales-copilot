import {
  interpolatePlaybookPlaceholders,
  isHttpsUrlAllowedForPlaybook,
  parsePlaybookHintJson,
  parsePlaybookUrlAllowlistEnv,
} from './playbook-resolver.lib';

describe('playbook-resolver.lib', () => {
  describe('interpolatePlaybookPlaceholders', () => {
    it('replaces {{keys}} with variables', () => {
      expect(
        interpolatePlaybookPlaceholders('Hello {{name}} — {{code}}', {
          name: 'Ada',
          code: 'X1',
        }),
      ).toBe('Hello Ada — X1');
    });

    it('uses empty string for missing keys', () => {
      expect(
        interpolatePlaybookPlaceholders('{{a}}-{{b}}', { a: '1' }),
      ).toBe('1-');
    });
  });

  describe('parsePlaybookHintJson', () => {
    it('parses playbook_template_key and playbook_variables', () => {
      const hint = parsePlaybookHintJson(
        JSON.stringify({
          playbook_template_key: 'spin_problem',
          playbook_variables: { phrase: 'Why now?' },
        }),
      );
      expect(hint).toEqual({
        templateKey: 'spin_problem',
        variables: { phrase: 'Why now?' },
      });
    });

    it('returns null for invalid JSON', () => {
      expect(parsePlaybookHintJson('{')).toBeNull();
    });

    it('returns null when template key missing', () => {
      expect(parsePlaybookHintJson('{"playbook_variables":{}}')).toBeNull();
    });
  });

  describe('isHttpsUrlAllowedForPlaybook', () => {
    it('allows exact hostname match', () => {
      const allow = parsePlaybookUrlAllowlistEnv('docs.example.com');
      expect(
        isHttpsUrlAllowedForPlaybook(
          'https://docs.example.com/path',
          allow,
        ),
      ).toBe(true);
    });

    it('allows subdomains of listed host', () => {
      const allow = parsePlaybookUrlAllowlistEnv('example.com');
      expect(
        isHttpsUrlAllowedForPlaybook(
          'https://app.example.com/x',
          allow,
        ),
      ).toBe(true);
    });

    it('rejects http', () => {
      const allow = parsePlaybookUrlAllowlistEnv('example.com');
      expect(
        isHttpsUrlAllowedForPlaybook('http://example.com/', allow),
      ).toBe(false);
    });

    it('rejects host not in allowlist', () => {
      const allow = parsePlaybookUrlAllowlistEnv('safe.example.com');
      expect(
        isHttpsUrlAllowedForPlaybook('https://evil.com/', allow),
      ).toBe(false);
    });

    it('rejects when allowlist empty', () => {
      expect(
        isHttpsUrlAllowedForPlaybook('https://example.com/', new Set()),
      ).toBe(false);
    });
  });
});
