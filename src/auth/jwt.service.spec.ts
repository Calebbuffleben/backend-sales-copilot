import { AuthJwtService } from './jwt.service';

describe('AuthJwtService (HS256 dev fallback)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-key-please-rotate-in-prod',
      JWT_PRIVATE_KEY: '',
      JWT_PUBLIC_KEY: '',
      JWT_ISSUER: 'meet-backend-test',
      JWT_AUDIENCE: 'meet-platform-test',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('signs and verifies an access token with all required claims', () => {
    const svc = new AuthJwtService();
    const token = svc.sign({
      subject: 'user-123',
      tenantId: 'tenant-abc',
      role: 'MEMBER',
      jti: 'jti-1',
      type: 'access',
      ttlSeconds: 60,
    });
    expect(typeof token).toBe('string');
    const claims = svc.verify(token, 'access');
    expect(claims.sub).toBe('user-123');
    expect(claims.tid).toBe('tenant-abc');
    expect(claims.role).toBe('MEMBER');
    expect(claims.jti).toBe('jti-1');
    expect(claims.type).toBe('access');
    expect(claims.iss).toBe('meet-backend-test');
    expect(claims.aud).toBe('meet-platform-test');
  });

  it('rejects the wrong token type', () => {
    const svc = new AuthJwtService();
    const refresh = svc.sign({
      subject: 'u',
      tenantId: 't',
      role: 'MEMBER',
      jti: 'j',
      type: 'refresh',
      ttlSeconds: 60,
    });
    expect(() => svc.verify(refresh, 'access')).toThrow(/Unexpected token type/);
  });

  it('rejects tokens signed with a different secret', () => {
    const svcA = new AuthJwtService();
    const token = svcA.sign({
      subject: 'u',
      tenantId: 't',
      role: 'MEMBER',
      jti: 'j',
      type: 'access',
      ttlSeconds: 60,
    });
    process.env.JWT_SECRET = 'different-secret';
    const svcB = new AuthJwtService();
    expect(() => svcB.verify(token, 'access')).toThrow(/JWT verification failed/);
  });

  it('throws when no keys are configured', () => {
    process.env.JWT_SECRET = '';
    expect(() => new AuthJwtService()).toThrow(/JWT keys missing/);
  });
});
