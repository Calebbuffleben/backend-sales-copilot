import {
  TenantContextService,
  assertTenantMatch,
  requireTenant,
  runWithTenant,
} from './tenant-context.service';
import {
  MissingTenantContextError,
  TenantMismatchError,
  TenantContext,
} from './tenant-context.types';

describe('TenantContextService (HTTP ALS)', () => {
  it('binds tenant context only inside runHttp', () => {
    const svc = new TenantContextService();
    const ctx: TenantContext = { userId: 'u1', tenantId: 't1', role: 'MEMBER' };
    expect(svc.getHttpContext()).toBeUndefined();
    svc.runHttp(ctx, () => {
      expect(svc.getHttpContext()).toEqual(ctx);
    });
    expect(svc.getHttpContext()).toBeUndefined();
  });

  it('bypass flag is scoped to its own runner', () => {
    const svc = new TenantContextService();
    expect(svc.isBypassActive()).toBe(false);
    svc.runWithTenantBypass(() => {
      expect(svc.isBypassActive()).toBe(true);
    });
    expect(svc.isBypassActive()).toBe(false);
  });
});

describe('tenant helpers', () => {
  it('requireTenant throws when tenantId is missing', () => {
    expect(() => requireTenant(undefined)).toThrow(MissingTenantContextError);
    expect(() => requireTenant({ tenantId: '' })).toThrow(
      MissingTenantContextError,
    );
    expect(requireTenant({ tenantId: 't1' })).toBe('t1');
  });

  it('runWithTenant threads context into the callback (no ALS)', () => {
    const ctx: TenantContext = { userId: 'u1', tenantId: 't1', role: 'MEMBER' };
    const received = runWithTenant(ctx, (c) => c.tenantId);
    expect(received).toBe('t1');
  });

  describe('assertTenantMatch', () => {
    it('accepts missing claimed tenant (redundant hint absent)', () => {
      expect(() => assertTenantMatch('t1', undefined)).not.toThrow();
      expect(() => assertTenantMatch('t1', null)).not.toThrow();
      expect(() => assertTenantMatch('t1', '')).not.toThrow();
    });

    it('accepts a matching claim', () => {
      expect(() => assertTenantMatch('t1', 't1')).not.toThrow();
    });

    it('rejects a mismatched claim with TenantMismatchError', () => {
      try {
        assertTenantMatch('t1', 't2');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TenantMismatchError);
        const typed = err as TenantMismatchError;
        expect(typed.tokenTenantId).toBe('t1');
        expect(typed.claimedTenantId).toBe('t2');
      }
    });
  });
});
