/**
 * In-memory PrismaService stand-in for e2e tests.
 *
 * Implements the tiny slice of Prisma used by AuthService + FeedbackService —
 * enough to exercise the full HTTP/auth stack without a real Postgres. This
 * is intentionally narrow: if you touch a new Prisma call path in a test,
 * add it here explicitly so we stay fail-loud.
 *
 * NOTE: signatures mimic Prisma's delegate shape (`findUnique`, `create`, …)
 * but cut corners on select/include — we return full objects and let the
 * test assert the fields it cares about.
 */

type Id = string;

interface TenantRow {
  id: Id;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: Id;
  tenantId: Id;
  email: string;
  passwordHash: string | null;
  name: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'SERVICE';
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RefreshTokenRow {
  id: Id;
  tenantId: Id;
  userId: Id;
  tokenHash: string;
  familyId: Id;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: Id | null;
  createdByIp: string | null;
  userAgent: string | null;
  createdAt: Date;
}

interface AuditLogRow {
  id: Id;
  tenantId: Id | null;
  userId: Id | null;
  action: string;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface FeedbackEventRow {
  id: Id;
  tenantId: Id;
  meetingId: string;
  participantId: string;
  type: string;
  severity: string;
  ts: Date;
  windowStart: Date;
  windowEnd: Date;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date | null;
}

function uid(prefix = ''): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function matchWhere<T extends Record<string, any>>(
  row: T,
  where: Record<string, any> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      if (!Array.isArray(value)) continue;
      if (!value.every((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!Array.isArray(value)) continue;
      if (!value.some((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchWhere(row, value as Record<string, any>)) return false;
      continue;
    }
    if (key === 'metadata' && value && typeof value === 'object' && 'path' in value) {
      const path = (value as any).path as string[];
      const wanted = (value as any).equals;
      let cur: any = row[key];
      for (const p of path) {
        cur = cur?.[p];
      }
      if (cur !== wanted) return false;
      continue;
    }
    if (key === 'createdAt' && value && typeof value === 'object') {
      const gte = (value as any).gte;
      if (gte && !(row[key] >= gte)) return false;
      continue;
    }
    if (key === 'tenantId_email' && value && typeof value === 'object') {
      if (
        row.tenantId !== (value as any).tenantId ||
        row.email !== (value as any).email
      ) {
        return false;
      }
      continue;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      // Unsupported deep filter — fall through and compare loosely.
      if (JSON.stringify(row[key]) !== JSON.stringify(value)) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

export function createInMemoryPrismaFake() {
  const tenants: TenantRow[] = [];
  const users: UserRow[] = [];
  const refreshTokens: RefreshTokenRow[] = [];
  const auditLogs: AuditLogRow[] = [];
  const feedbackEvents: FeedbackEventRow[] = [];

  const api = {
    // -------------------------- lifecycle ------------------------------ //
    async $connect() {},
    async $disconnect() {},
    $use(_mw: unknown) {
      // Intentionally no-op: the tenancy middleware relies on ALS which we
      // don't want to apply here — tests directly drive the controllers.
    },

    // -------------------------- Tenant -------------------------------- //
    tenant: {
      async findUnique({ where }: any) {
        return (
          tenants.find((t) => matchWhere(t, where)) ?? null
        );
      },
      async create({ data }: any) {
        const row: TenantRow = {
          id: uid('tnt_'),
          slug: data.slug,
          name: data.name,
          status: data.status ?? 'ACTIVE',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tenants.push(row);
        return row;
      },
    },

    // -------------------------- User ---------------------------------- //
    user: {
      async findUnique({ where }: any) {
        if (where?.tenantId_email) {
          return (
            users.find(
              (u) =>
                u.tenantId === where.tenantId_email.tenantId &&
                u.email === where.tenantId_email.email,
            ) ?? null
          );
        }
        return users.find((u) => matchWhere(u, where)) ?? null;
      },
      async count({ where }: any) {
        return users.filter((u) => matchWhere(u, where)).length;
      },
      async create({ data }: any) {
        const row: UserRow = {
          id: uid('usr_'),
          tenantId: data.tenantId,
          email: data.email,
          passwordHash: data.passwordHash ?? null,
          name: data.name ?? null,
          role: data.role ?? 'MEMBER',
          isActive: data.isActive ?? true,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = users.findIndex((u) => matchWhere(u, where));
        if (idx < 0) throw new Error('user not found');
        users[idx] = { ...users[idx], ...data, updatedAt: new Date() };
        return users[idx];
      },
    },

    // -------------------------- RefreshToken -------------------------- //
    refreshToken: {
      async findUnique({ where }: any) {
        return (
          refreshTokens.find((r) => matchWhere(r, where)) ?? null
        );
      },
      async create({ data }: any) {
        const row: RefreshTokenRow = {
          id: data.id ?? uid('rt_'),
          tenantId: data.tenantId,
          userId: data.userId,
          tokenHash: data.tokenHash,
          familyId: data.familyId,
          expiresAt: data.expiresAt,
          revokedAt: null,
          replacedById: null,
          createdByIp: data.createdByIp ?? null,
          userAgent: data.userAgent ?? null,
          createdAt: new Date(),
        };
        refreshTokens.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = refreshTokens.findIndex((r) => matchWhere(r, where));
        if (idx < 0) throw new Error('refresh token not found');
        refreshTokens[idx] = { ...refreshTokens[idx], ...data };
        return refreshTokens[idx];
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const r of refreshTokens) {
          if (matchWhere(r, where)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },

    // -------------------------- AuditLog ------------------------------ //
    auditLog: {
      async create({ data }: any) {
        const row: AuditLogRow = {
          id: uid('al_'),
          tenantId: data.tenantId ?? null,
          userId: data.userId ?? null,
          action: data.action,
          target: data.target ?? null,
          ip: data.ip ?? null,
          userAgent: data.userAgent ?? null,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
        };
        auditLogs.push(row);
        return row;
      },
      async count({ where }: any) {
        return auditLogs.filter((a) => matchWhere(a, where)).length;
      },
      async findMany({ where, take }: any) {
        const hits = auditLogs.filter((a) => matchWhere(a, where));
        return take ? hits.slice(0, take) : hits;
      },
      async update({ where, data }: any) {
        const idx = auditLogs.findIndex((a) => matchWhere(a, where));
        if (idx < 0) throw new Error('audit log not found');
        auditLogs[idx] = { ...auditLogs[idx], ...data };
        return auditLogs[idx];
      },
    },

    // -------------------------- FeedbackEvent ------------------------- //
    feedbackEvent: {
      async findMany({ where, take, orderBy }: any) {
        let rows = feedbackEvents.filter((f) => matchWhere(f, where));
        if (orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      async findFirst({ where }: any) {
        return feedbackEvents.find((f) => matchWhere(f, where)) ?? null;
      },
      async count({ where }: any) {
        return feedbackEvents.filter((f) => matchWhere(f, where)).length;
      },
      async create({ data }: any) {
        const row: FeedbackEventRow = {
          id: data.id ?? uid('fb_'),
          tenantId: data.tenantId,
          meetingId: data.meetingId,
          participantId: data.participantId,
          type: data.type,
          severity: data.severity,
          ts: data.ts,
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          message: data.message,
          metadata: data.metadata,
          createdAt: new Date(),
          expiresAt: data.expiresAt ?? null,
        };
        feedbackEvents.push(row);
        return row;
      },
      async aggregate() {
        return { _count: { _all: feedbackEvents.length } };
      },
      async groupBy() {
        return [];
      },
    },

    // -------------------------- test escape hatches ------------------- //
    _dumpTenants: () => tenants.slice(),
    _dumpUsers: () => users.slice(),
    _dumpRefreshTokens: () => refreshTokens.slice(),
    _dumpAuditLogs: () => auditLogs.slice(),
    _dumpFeedbackEvents: () => feedbackEvents.slice(),
  };

  return api;
}
