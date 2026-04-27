import type { TokenRole } from '../auth/role.types';

/**
 * Authoritative identity + tenant context derived from a verified JWT.
 *
 * `tenantId` is always `token.tid` — never a client-provided value.
 * `membershipId` is `null` for SERVICE tokens (which are tenant-scoped
 * via `token.tid` but do not belong to a user membership).
 */
export interface TenantContext {
  userId: string;
  tenantId: string;
  /** `null` when the token is a SERVICE token (no DB membership row). */
  membershipId: string | null;
  role: TokenRole;
  /** Internal flag allowing service tokens to bypass user-specific checks when appropriate. */
  isService?: boolean;
  /** Token identifier (jti) — kept for audit/revocation correlation. */
  jti?: string;
}

export class MissingTenantContextError extends Error {
  readonly code = 'MISSING_TENANT_CONTEXT';
  constructor(reason = 'tenant context required but not present') {
    super(reason);
    this.name = 'MissingTenantContextError';
  }
}

export class TenantMismatchError extends Error {
  readonly code = 'TENANT_MISMATCH';
  constructor(
    public readonly tokenTenantId: string,
    public readonly claimedTenantId: string,
  ) {
    super(
      `Tenant mismatch: token="${tokenTenantId}" claimed="${claimedTenantId}"`,
    );
    this.name = 'TenantMismatchError';
  }
}
