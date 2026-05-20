import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PlaybookTemplate } from '@prisma/client';
import {
  FeedbackPlaybookMetadata,
  PLAYBOOK_MAX_ACTION_PAYLOAD_CHARS,
  PLAYBOOK_MAX_STEP_DETAIL_CHARS,
  PLAYBOOK_MAX_STEP_ID_CHARS,
  PLAYBOOK_MAX_STEP_LABEL_CHARS,
  PLAYBOOK_MAX_STEPS,
  PLAYBOOK_MAX_TEMPLATE_KEY_CHARS,
  PLAYBOOK_MAX_TITLE_CHARS,
  PlaybookActionType,
  PlaybookStepResolved,
} from './playbook-metadata.contract';
import {
  interpolatePlaybookPlaceholders,
  isHttpsUrlAllowedForPlaybook,
  parsePlaybookHintJson,
  parsePlaybookUrlAllowlistEnv,
  ParsedPlaybookHint,
} from './playbook-resolver.lib';

type RawStep = {
  id?: unknown;
  label?: unknown;
  detail?: unknown;
  action?: { type?: unknown; payload?: unknown };
};

@Injectable()
export class PlaybookResolverService {
  private readonly logger = new Logger(PlaybookResolverService.name);
  private readonly urlAllowlist: Set<string>;

  constructor(private readonly prisma: PrismaService) {
    this.urlAllowlist = parsePlaybookUrlAllowlistEnv(
      process.env.PLAYBOOK_URL_ALLOWLIST,
    );
  }

  /**
   * Resolve `metadata.playbook` from optional JSON hint + tenant playbook template row.
   */
  async resolve(params: {
    tenantId: string;
    playbookHintJson?: string | null;
  }): Promise<FeedbackPlaybookMetadata | undefined> {
    const { tenantId } = params;
    const hint = parsePlaybookHintJson(params.playbookHintJson ?? undefined);
    if (!hint) return undefined;

    const normalizedKey = this.normalizeTemplateKey(hint.templateKey);
    if (!normalizedKey) return undefined;

    const template = await this.prisma.playbookTemplate.findUnique({
      where: {
        tenantId_key: { tenantId, key: normalizedKey },
      },
    });

    if (!template) {
      this.logger.debug(
        `Playbook template not found | tenantId=%s | key=%s`,
        tenantId,
        normalizedKey,
      );
      return undefined;
    }

    return this.buildMetadata(template, hint, normalizedKey);
  }

  private normalizeTemplateKey(key: string): string | undefined {
    const t = key.trim();
    if (!t) return undefined;
    if (t.length > PLAYBOOK_MAX_TEMPLATE_KEY_CHARS) {
      return t.slice(0, PLAYBOOK_MAX_TEMPLATE_KEY_CHARS);
    }
    return t;
  }

  private buildMetadata(
    template: Pick<PlaybookTemplate, 'title' | 'steps'>,
    hint: ParsedPlaybookHint,
    resolvedKey: string,
  ): FeedbackPlaybookMetadata | undefined {
    const vars = hint.variables;
    const titleRaw = interpolatePlaybookPlaceholders(
      template.title ?? '',
      vars,
    );
    const title = this.truncate(titleRaw, PLAYBOOK_MAX_TITLE_CHARS);
    const stepsRaw = this.coerceStepsArray(template.steps);
    const steps: PlaybookStepResolved[] = [];

    for (const raw of stepsRaw) {
      if (steps.length >= PLAYBOOK_MAX_STEPS) break;
      const resolved = this.resolveStep(raw, vars);
      if (resolved) steps.push(resolved);
    }

    if (steps.length === 0) return undefined;

    return {
      templateKey: resolvedKey,
      ...(title ? { title } : {}),
      steps,
    };
  }

  private coerceStepsArray(stepsJson: unknown): RawStep[] {
    if (!Array.isArray(stepsJson)) return [];
    return stepsJson as RawStep[];
  }

  private resolveStep(
    raw: RawStep,
    vars: Record<string, string>,
  ): PlaybookStepResolved | undefined {
    const idSrc =
      typeof raw.id === 'string' ? raw.id : raw.id != null ? String(raw.id) : '';
    const labelSrc =
      typeof raw.label === 'string'
        ? raw.label
        : raw.label != null
          ? String(raw.label)
          : '';
    const id = this.truncate(
      interpolatePlaybookPlaceholders(idSrc.trim(), vars),
      PLAYBOOK_MAX_STEP_ID_CHARS,
    );
    const label = this.truncate(
      interpolatePlaybookPlaceholders(labelSrc.trim(), vars),
      PLAYBOOK_MAX_STEP_LABEL_CHARS,
    );
    if (!id || !label) return undefined;

    let detail: string | undefined;
    if (raw.detail != null && raw.detail !== '') {
      const d =
        typeof raw.detail === 'string'
          ? raw.detail
          : String(raw.detail);
      const di = this.truncate(
        interpolatePlaybookPlaceholders(d.trim(), vars),
        PLAYBOOK_MAX_STEP_DETAIL_CHARS,
      );
      if (di) detail = di;
    }

    const actionRaw = raw.action;
    if (!actionRaw || typeof actionRaw !== 'object') return undefined;
    const typeStr =
      typeof actionRaw.type === 'string'
        ? actionRaw.type.trim().toLowerCase()
        : '';
    const payloadSrc =
      typeof actionRaw.payload === 'string'
        ? actionRaw.payload
        : actionRaw.payload != null
          ? String(actionRaw.payload)
          : '';

    const payloadInterpolated = interpolatePlaybookPlaceholders(
      payloadSrc,
      vars,
    );
    const payload = this.truncate(
      payloadInterpolated,
      PLAYBOOK_MAX_ACTION_PAYLOAD_CHARS,
    );

    const actionType = this.normalizeActionType(typeStr);
    if (!actionType) return undefined;

    const safeAction = this.sanitizeAction(actionType, payload);
    if (!safeAction) return undefined;

    const step: PlaybookStepResolved = {
      id,
      label,
      ...(detail !== undefined ? { detail } : {}),
      action: safeAction,
    };
    return step;
  }

  private normalizeActionType(s: string): PlaybookActionType | undefined {
    if (s === 'copy_text' || s === 'open_url' || s === 'noop') return s;
    return undefined;
  }

  private sanitizeAction(
    type: PlaybookActionType,
    payload: string,
  ): { type: PlaybookActionType; payload: string } | undefined {
    if (type === 'noop') {
      return { type: 'noop', payload: '' };
    }
    if (type === 'copy_text') {
      if (!payload.trim()) return undefined;
      return { type: 'copy_text', payload };
    }
    if (type === 'open_url') {
      if (!isHttpsUrlAllowedForPlaybook(payload, this.urlAllowlist)) {
        this.logger.warn(
          'Playbook open_url rejected (not https or not in PLAYBOOK_URL_ALLOWLIST) | url=%s',
          payload.slice(0, 120),
        );
        return undefined;
      }
      return { type: 'open_url', payload };
    }
    return undefined;
  }

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max);
  }
}
