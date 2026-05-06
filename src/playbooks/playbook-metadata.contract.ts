/**
 * Canonical wire shape for `metadata.playbook` on Socket.IO feedback broadcasts.
 * Keep in sync with desktop-app/src/shared/playbook-metadata.ts (Passo 0 contract).
 */

/** Hard cap on actionable steps shown per insight (overlay + resolver). */
export const PLAYBOOK_MAX_STEPS = 5;

/** Short primary label on each action button. */
export const PLAYBOOK_MAX_STEP_LABEL_CHARS = 120;

/** Optional subtitle / tooltip line under the button label. */
export const PLAYBOOK_MAX_STEP_DETAIL_CHARS = 280;

/** Clipboard text or URL payload after interpolation (URLs validated separately). */
export const PLAYBOOK_MAX_ACTION_PAYLOAD_CHARS = 2000;

/** Tenant template slug referenced by LLM hints (`playbook_template_key`). */
export const PLAYBOOK_MAX_TEMPLATE_KEY_CHARS = 64;

/** Optional heading above the action row (main coaching remains in `message`). */
export const PLAYBOOK_MAX_TITLE_CHARS = 160;

/** Step id (stable for future analytics). */
export const PLAYBOOK_MAX_STEP_ID_CHARS = 64;

export type PlaybookActionType = 'copy_text' | 'open_url' | 'noop';

/**
 * One resolved playbook row for the UI. All strings must satisfy length caps above.
 */
export interface PlaybookStepResolved {
  id: string;
  label: string;
  detail?: string;
  action: {
    type: PlaybookActionType;
    /** For copy_text: text to copy. For open_url: https URL only (host allowlist server-side). */
    payload: string;
  };
}

/**
 * Value nested at `metadata.playbook` on feedback events consumed by the desktop overlay.
 */
export interface FeedbackPlaybookMetadata {
  /** Optional echo of which tenant template was merged (for debugging / analytics). */
  templateKey?: string;
  /** Optional short heading above actions; main coaching text stays in `message`. */
  title?: string;
  steps: PlaybookStepResolved[];
}
