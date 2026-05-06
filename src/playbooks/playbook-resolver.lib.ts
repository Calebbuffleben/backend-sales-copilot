/**
 * Pure helpers for playbook hint parsing, {{var}} interpolation, and URL allowlist checks.
 */

const PLACEHOLDER_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

export type ParsedPlaybookHint = {
  templateKey: string;
  variables: Record<string, string>;
};

/** Split env like "a.com,b.com" into lowercase hostnames (no scheme). */
export function parsePlaybookUrlAllowlistEnv(raw: string | undefined): Set<string> {
  const s = raw?.trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

export function interpolatePlaybookPlaceholders(
  input: string,
  variables: Record<string, string>,
): string {
  return input.replace(PLACEHOLDER_RE, (_, key: string) => variables[key] ?? '');
}

function hostnameAllowed(hostname: string, allowlist: Set<string>): boolean {
  const h = hostname.toLowerCase();
  if (allowlist.has(h)) return true;
  for (const base of allowlist) {
    if (h.endsWith('.' + base)) return true;
  }
  return false;
}

/** True if url is https and hostname matches allowlist (or allowlist empty => deny open_url). */
export function isHttpsUrlAllowedForPlaybook(
  urlString: string,
  allowlist: Set<string>,
): boolean {
  if (allowlist.size === 0) return false;
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:') return false;
    return hostnameAllowed(u.hostname, allowlist);
  } catch {
    return false;
  }
}

export function parsePlaybookHintJson(
  raw: string | null | undefined,
): ParsedPlaybookHint | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    const keyRaw =
      obj.playbook_template_key ?? obj.template_key ?? obj.playbookTemplateKey;
    const templateKey =
      typeof keyRaw === 'string' ? keyRaw.trim() : '';
    if (!templateKey) return null;

    const varsRaw =
      obj.playbook_variables ??
      obj.playbookVariables ??
      obj.variables ??
      {};
    const variables: Record<string, string> = {};
    if (varsRaw && typeof varsRaw === 'object' && !Array.isArray(varsRaw)) {
      for (const [k, v] of Object.entries(varsRaw)) {
        if (typeof v === 'string') variables[k] = v;
        else if (v != null) variables[k] = String(v);
      }
    }

    return { templateKey, variables };
  } catch {
    return null;
  }
}
