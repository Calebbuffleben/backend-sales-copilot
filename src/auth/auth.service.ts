import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { TenantStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuthJwtService } from './jwt.service';
import {
  ARGON2_OPTIONS,
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  DEFAULT_SERVICE_TTL_SECONDS,
} from './auth.constants';
import {
  LoginDto,
  RefreshDto,
  RegisterDto,
  ServiceTokenDto,
} from './dto/auth.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  refreshExpiresAt: number; // epoch ms
  tokenType: 'Bearer';
}

export interface AuthSession extends AuthTokens {
  user: {
    id: string;
    tenantId: string;
    email: string;
    name: string | null;
    role: UserRole;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
  };
}

interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly allowSelfSignup: boolean;
  private readonly lockoutWindowSeconds: number;
  private readonly lockoutThreshold: number;
  private readonly lockoutIpThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: AuthJwtService,
  ) {
    this.accessTtlSeconds = numFromEnv(
      'JWT_ACCESS_TTL_SECONDS',
      DEFAULT_ACCESS_TTL_SECONDS,
    );
    this.refreshTtlSeconds = numFromEnv(
      'JWT_REFRESH_TTL_SECONDS',
      DEFAULT_REFRESH_TTL_SECONDS,
    );
    this.allowSelfSignup =
      String(process.env.ALLOW_SELF_SIGNUP || '').toLowerCase() === 'true';
    // Login lockout (complements per-route throttle). Enforces an upper
    // bound on failed attempts over a sliding window, scoped by email
    // (tenantId + email) AND by IP. Reset on successful login.
    this.lockoutWindowSeconds = numFromEnv('AUTH_LOCKOUT_WINDOW_SECONDS', 300);
    this.lockoutThreshold = numFromEnv('AUTH_LOCKOUT_EMAIL_THRESHOLD', 5);
    this.lockoutIpThreshold = numFromEnv('AUTH_LOCKOUT_IP_THRESHOLD', 20);
  }

  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthSession> {
    if (!this.allowSelfSignup) {
      throw new UnauthorizedException(
        'Self-signup is disabled (set ALLOW_SELF_SIGNUP=true)',
      );
    }
    const email = dto.email.trim().toLowerCase();
    const tenantSlug = (dto.tenantSlug || 'default').trim().toLowerCase();

    return this.tenantCtx.runWithTenantBypass(async () => {
      const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

      const existingTenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });

      // First registration for a tenant creates OWNER; subsequent ones become MEMBER.
      let tenant = existingTenant;
      if (!tenant) {
        tenant = await this.prisma.tenant.create({
          data: {
            slug: tenantSlug,
            name: dto.tenantName?.trim() || tenantSlug,
            status: TenantStatus.ACTIVE,
          },
        });
      }

      const existingUser = await this.prisma.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email } },
      });
      if (existingUser) {
        throw new ConflictException('Email already registered for this tenant');
      }

      const memberCount = await this.prisma.user.count({
        where: { tenantId: tenant.id },
      });
      const role: UserRole = memberCount === 0 ? UserRole.OWNER : UserRole.MEMBER;

      const user = await this.prisma.user.create({
        data: {
          tenantId: tenant.id,
          email,
          passwordHash,
          name: dto.name?.trim() || null,
          role,
          isActive: true,
        },
      });

      await this.writeAuditLog(tenant.id, user.id, 'auth.register', meta);

      const tokens = await this.issueTokens(
        { userId: user.id, tenantId: tenant.id, role: user.role },
        meta,
      );

      return this.toSession(
        tokens,
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthSession> {
    const email = dto.email.trim().toLowerCase();
    const tenantSlug = (dto.tenantSlug || 'default').trim().toLowerCase();

    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // --- Lockout gate (complements per-route rate limit) ---
      // Count failed attempts over the sliding window and block when the
      // per-email or per-IP threshold is reached. Resets on successful
      // login below.
      const locked = await this.isLoginLocked(tenant.id, email, meta.ip);
      if (locked) {
        await this.writeAuditLog(tenant.id, null, 'auth.login.lockout', meta, {
          email,
          reason: 'threshold_exceeded',
        });
        throw new UnauthorizedException(
          'Too many failed attempts. Try again later.',
        );
      }

      const user = await this.prisma.user.findUnique({
        where: { tenantId_email: { tenantId: tenant.id, email } },
      });
      if (!user || !user.isActive || !user.passwordHash) {
        // Still run argon2.verify against a decoy hash to mitigate timing
        // side-channels (best-effort; DB latency dominates anyway).
        await argon2.hash('decoy-password-for-timing', ARGON2_OPTIONS).catch(() => undefined);
        await this.writeAuditLog(tenant.id, null, 'auth.login.fail', meta, { email });
        throw new UnauthorizedException('Invalid credentials');
      }

      const ok = await argon2.verify(user.passwordHash, dto.password);
      if (!ok) {
        await this.writeAuditLog(tenant.id, user.id, 'auth.login.fail', meta, {
          email,
        });
        throw new UnauthorizedException('Invalid credentials');
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      // Reset the lockout counter on success: mark any recent failure rows
      // for this (tenant, email) pair as consumed so the window no longer
      // counts them. We use metadata instead of deleting for auditability.
      await this.resetLoginFailures(tenant.id, email);

      await this.writeAuditLog(tenant.id, user.id, 'auth.login.ok', meta);

      const tokens = await this.issueTokens(
        { userId: user.id, tenantId: tenant.id, role: user.role },
        meta,
      );

      return this.toSession(
        tokens,
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async refresh(dto: RefreshDto, meta: RequestMeta): Promise<AuthSession> {
    const claims = (() => {
      try {
        return this.jwt.verify(dto.refreshToken, 'refresh');
      } catch (err) {
        throw new UnauthorizedException(
          err instanceof Error ? err.message : 'Invalid refresh token',
        );
      }
    })();

    return this.tenantCtx.runWithTenantBypass(async () => {
      const tokenHash = hashRefresh(dto.refreshToken);
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
      });

      if (!stored || stored.tenantId !== claims.tid || stored.userId !== claims.sub) {
        // Token doesn't exist or doesn't match — treat as reuse attempt and
        // revoke entire family if we have one. Token may have been rotated.
        if (stored) {
          await this.revokeFamily(stored.familyId, 'refresh.mismatch');
        }
        await this.writeAuditLog(
          claims.tid,
          claims.sub,
          'auth.refresh.mismatch',
          meta,
        );
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (stored.revokedAt) {
        // Reuse of a revoked token — kill the whole family.
        await this.revokeFamily(stored.familyId, 'refresh.reuse');
        await this.writeAuditLog(
          stored.tenantId,
          stored.userId,
          'auth.refresh.reuse',
          meta,
        );
        throw new UnauthorizedException('Refresh token revoked');
      }

      if (stored.expiresAt.getTime() < Date.now()) {
        throw new UnauthorizedException('Refresh token expired');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: stored.userId },
      });
      if (!user || !user.isActive || user.tenantId !== stored.tenantId) {
        throw new UnauthorizedException('User no longer active');
      }

      const tenant = await this.prisma.tenant.findUnique({
        where: { id: stored.tenantId },
      });
      if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
        throw new UnauthorizedException('Tenant unavailable');
      }

      // Rotate: revoke old token, issue new one in the same family.
      const newTokens = await this.issueTokens(
        { userId: user.id, tenantId: tenant.id, role: user.role },
        meta,
        { familyId: stored.familyId },
      );

      const newHash = hashRefresh(newTokens.refreshToken);
      const newRow = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: newHash },
      });
      await this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedById: newRow?.id ?? null },
      });

      await this.writeAuditLog(
        stored.tenantId,
        stored.userId,
        'auth.refresh.ok',
        meta,
      );

      return this.toSession(
        newTokens,
        { id: user.id, email: user.email, name: user.name, role: user.role },
        { id: tenant.id, slug: tenant.slug, name: tenant.name },
      );
    });
  }

  async logout(
    ctx: { userId: string; tenantId: string },
    refreshToken: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    await this.tenantCtx.runWithTenantBypass(async () => {
      if (refreshToken) {
        const tokenHash = hashRefresh(refreshToken);
        const stored = await this.prisma.refreshToken.findUnique({
          where: { tokenHash },
        });
        if (stored && stored.tenantId === ctx.tenantId && !stored.revokedAt) {
          await this.revokeFamily(stored.familyId, 'auth.logout');
        }
      } else {
        // No explicit token — revoke ALL active refresh tokens for this user.
        await this.prisma.refreshToken.updateMany({
          where: {
            userId: ctx.userId,
            tenantId: ctx.tenantId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
      await this.writeAuditLog(ctx.tenantId, ctx.userId, 'auth.logout', meta);
    });
  }

  async me(userId: string, tenantId: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.tenantId !== tenantId) {
        throw new UnauthorizedException('User not found');
      }
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId,
        },
        tenant: tenant
          ? { id: tenant.id, slug: tenant.slug, name: tenant.name }
          : null,
      };
    });
  }

  /**
   * Mint a short-lived service token scoped to a single tenant.
   *
   * Protected at the controller layer by a shared `SERVICE_BOOTSTRAP_KEY`.
   * This is intentionally a *bootstrap* endpoint — production should rotate
   * the resulting JWT well before `ttlSeconds` expires (e.g. via a cron in
   * the client service that re-hits this endpoint with the bootstrap key).
   */
  async mintServiceToken(
    dto: ServiceTokenDto,
    meta: RequestMeta,
  ): Promise<{
    token: string;
    tokenType: 'Bearer';
    tenantId: string;
    tenantSlug: string;
    expiresAt: number;
    label: string | null;
  }> {
    const tenantSlug = dto.tenantSlug.trim().toLowerCase();
    const label = dto.label?.trim().slice(0, 128) || null;

    // Clamp TTL to a sensible range (min 60s, max 6 * default).
    const maxTtl = DEFAULT_SERVICE_TTL_SECONDS * 6;
    const requested = Number.isFinite(dto.ttlSeconds as number)
      ? Math.floor(Number(dto.ttlSeconds))
      : DEFAULT_SERVICE_TTL_SECONDS;
    const ttlSeconds = Math.min(Math.max(requested, 60), maxTtl);

    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { slug: tenantSlug },
      });
      if (!tenant || tenant.status !== TenantStatus.ACTIVE) {
        throw new BadRequestException('Unknown or inactive tenant');
      }

      const jti = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const token = this.jwt.sign({
        subject: `service:${tenant.slug}`,
        tenantId: tenant.id,
        role: UserRole.SERVICE,
        jti,
        type: 'service',
        ttlSeconds,
      });

      await this.writeAuditLog(
        tenant.id,
        null,
        'auth.service_token.mint',
        meta,
        { label, ttlSeconds, jti },
      );

      return {
        token,
        tokenType: 'Bearer' as const,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        expiresAt: (now + ttlSeconds) * 1000,
        label,
      };
    });
  }

  /** Count recent `auth.login.fail` rows and compare against thresholds. */
  private async isLoginLocked(
    tenantId: string,
    email: string,
    ip: string | undefined,
  ): Promise<boolean> {
    const since = new Date(Date.now() - this.lockoutWindowSeconds * 1000);

    // Per-(tenant,email): each failure row stores the attempted email in
    // `metadata.email`. We query using JSON path to keep the cost low.
    const emailFailures = await this.prisma.auditLog.count({
      where: {
        tenantId,
        action: 'auth.login.fail',
        createdAt: { gte: since },
        // Prisma JSON filter: matches rows where metadata.email === email
        // and metadata.lockoutReset is not true (i.e. still counted).
        AND: [
          { metadata: { path: ['email'], equals: email } },
        ],
        NOT: {
          metadata: { path: ['lockoutReset'], equals: true },
        },
      },
    });
    if (emailFailures >= this.lockoutThreshold) return true;

    if (ip) {
      const ipFailures = await this.prisma.auditLog.count({
        where: {
          tenantId,
          action: 'auth.login.fail',
          createdAt: { gte: since },
          ip,
          NOT: {
            metadata: { path: ['lockoutReset'], equals: true },
          },
        },
      });
      if (ipFailures >= this.lockoutIpThreshold) return true;
    }

    return false;
  }

  /** Mark prior failures as reset so they no longer count against lockout. */
  private async resetLoginFailures(
    tenantId: string,
    email: string,
  ): Promise<void> {
    try {
      const since = new Date(Date.now() - this.lockoutWindowSeconds * 1000);
      const rows = await this.prisma.auditLog.findMany({
        where: {
          tenantId,
          action: 'auth.login.fail',
          createdAt: { gte: since },
          AND: [{ metadata: { path: ['email'], equals: email } }],
        },
        select: { id: true, metadata: true },
        take: 100,
      });
      for (const row of rows) {
        const md =
          row.metadata && typeof row.metadata === 'object'
            ? { ...(row.metadata as Record<string, unknown>) }
            : {};
        md.lockoutReset = true;
        await this.prisma.auditLog.update({
          where: { id: row.id },
          data: { metadata: md as any },
        });
      }
    } catch (err) {
      this.logger.warn(
        `[AuthService] failed to reset lockout counters: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async issueTokens(
    subject: { userId: string; tenantId: string; role: UserRole },
    meta: RequestMeta,
    opts: { familyId?: string } = {},
  ): Promise<AuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessJti = randomUUID();
    const refreshJti = randomUUID();

    const accessToken = this.jwt.sign({
      subject: subject.userId,
      tenantId: subject.tenantId,
      role: subject.role,
      jti: accessJti,
      type: 'access',
      ttlSeconds: this.accessTtlSeconds,
    });

    const refreshToken = this.jwt.sign({
      subject: subject.userId,
      tenantId: subject.tenantId,
      role: subject.role,
      jti: refreshJti,
      type: 'refresh',
      ttlSeconds: this.refreshTtlSeconds,
    });

    const familyId = opts.familyId ?? randomUUID();
    const expiresAt = new Date((now + this.refreshTtlSeconds) * 1000);

    await this.prisma.refreshToken.create({
      data: {
        id: refreshJti,
        tenantId: subject.tenantId,
        userId: subject.userId,
        tokenHash: hashRefresh(refreshToken),
        familyId,
        expiresAt,
        createdByIp: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessExpiresAt: (now + this.accessTtlSeconds) * 1000,
      refreshExpiresAt: expiresAt.getTime(),
      tokenType: 'Bearer',
    };
  }

  private async revokeFamily(familyId: string, _reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private toSession(
    tokens: AuthTokens,
    user: { id: string; email: string; name: string | null; role: UserRole },
    tenant: { id: string; slug: string; name: string },
  ): AuthSession {
    return {
      ...tokens,
      user: {
        id: user.id,
        tenantId: tenant.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      tenant,
    };
  }

  private async writeAuditLog(
    tenantId: string | null,
    userId: string | null,
    action: string,
    meta: RequestMeta,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: tenantId ?? undefined,
          userId: userId ?? undefined,
          action,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: extra ? (extra as any) : undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `[AuthService] audit write failed for ${action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
