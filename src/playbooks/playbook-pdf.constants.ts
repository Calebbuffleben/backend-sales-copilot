/** Max PDF upload size (admin path only — never on Live hot path). */
export const PLAYBOOK_PDF_MAX_BYTES = 10 * 1024 * 1024;

/** Cap stored full extract in Postgres. */
export const PLAYBOOK_SOURCE_TEXT_MAX_CHARS = 80_000;

/** Cap for Live catalog / TF-IDF (latency-safe). */
export const PLAYBOOK_SOURCE_TEXT_EXCERPT_MAX_CHARS = 2_000;
