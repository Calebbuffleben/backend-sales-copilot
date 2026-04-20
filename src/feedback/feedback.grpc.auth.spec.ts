import * as grpc from '@grpc/grpc-js';

import { AuthJwtService } from '../auth/jwt.service';
import { FeedbackGrpcServer } from './feedback.grpc.server';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { TenantMismatchError } from '../tenancy/tenant-context.types';

describe('FeedbackGrpcServer.authenticate', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      JWT_SECRET: 'feedback-grpc-test-secret',
      JWT_PRIVATE_KEY: '',
      JWT_PUBLIC_KEY: '',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const buildServer = () => {
    const jwt = new AuthJwtService();
    const auditCalls: unknown[] = [];
    const prisma = {
      auditLog: {
        create: jest.fn(async (args: unknown) => {
          auditCalls.push(args);
        }),
      },
    };
    const tenantCtx = new TenantContextService();
    const llm = {
      handleIngress: jest.fn(async () => undefined),
    };
    const server = new FeedbackGrpcServer(
      llm as any,
      jwt,
      prisma as any,
      tenantCtx,
    );
    return { server, jwt, prisma, auditCalls };
  };

  // `authenticate` is private; we invoke it via the bracket trick so tests
  // assert the security contract without opening a test-only public API.
  const callAuth = (server: FeedbackGrpcServer, metadata: grpc.Metadata) =>
    (server as unknown as {
      authenticate: (m: grpc.Metadata) => unknown;
    }).authenticate(metadata);

  it('rejects calls with no authorization metadata', () => {
    const { server } = buildServer();
    const md = new grpc.Metadata();
    expect(() => callAuth(server, md)).toThrow(/missing authorization metadata/);
  });

  it('rejects calls with a non-Bearer scheme', () => {
    const { server } = buildServer();
    const md = new grpc.Metadata();
    md.add('authorization', 'Basic abcd');
    expect(() => callAuth(server, md)).toThrow(/invalid authorization scheme/);
  });

  it('accepts an access token and derives tenantId from token.tid', () => {
    const { server, jwt } = buildServer();
    const token = jwt.sign({
      subject: 'user-1',
      tenantId: 'tenant-1',
      membershipId: 'm-1',
      role: 'MEMBER',
      jti: 'jti-1',
      type: 'access',
      ttlSeconds: 60,
    });
    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${token}`);
    const result = callAuth(server, md) as {
      ctx: { tenantId: string; userId: string; isService?: boolean };
    };
    expect(result.ctx.userId).toBe('user-1');
    expect(result.ctx.tenantId).toBe('tenant-1');
    expect(result.ctx.isService).toBeFalsy();
  });

  it('accepts an access token when x-tenant-id matches (redundant hint)', () => {
    const { server, jwt } = buildServer();
    const token = jwt.sign({
      subject: 'user-1',
      tenantId: 'tenant-1',
      membershipId: 'm-1',
      role: 'MEMBER',
      jti: 'jti-1',
      type: 'access',
      ttlSeconds: 60,
    });
    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${token}`);
    md.add('x-tenant-id', 'tenant-1');
    const result = callAuth(server, md) as { ctx: { tenantId: string } };
    expect(result.ctx.tenantId).toBe('tenant-1');
  });

  it('rejects access tokens when x-tenant-id does not match token.tid', () => {
    const { server, jwt, prisma } = buildServer();
    const token = jwt.sign({
      subject: 'user-1',
      tenantId: 'tenant-1',
      membershipId: 'm-1',
      role: 'MEMBER',
      jti: 'jti-1',
      type: 'access',
      ttlSeconds: 60,
    });
    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${token}`);
    md.add('x-tenant-id', 'tenant-evil');
    expect(() => callAuth(server, md)).toThrow(TenantMismatchError);
    // Audit log fires asynchronously; flush microtasks.
    return Promise.resolve().then(() => {
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  it('service tokens REQUIRE x-tenant-id and adopt it as the effective tenant', () => {
    const { server, jwt } = buildServer();
    const svcToken = jwt.sign({
      subject: 'python-pipeline',
      tenantId: 'tenant-source-ignored',
      role: 'SERVICE',
      jti: 'svc-1',
      type: 'service',
      ttlSeconds: 120,
    });
    const mdMissing = new grpc.Metadata();
    mdMissing.add('authorization', `Bearer ${svcToken}`);
    expect(() => callAuth(server, mdMissing)).toThrow(
      /service tokens require x-tenant-id/,
    );

    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${svcToken}`);
    md.add('x-tenant-id', 'tenant-42');
    const result = callAuth(server, md) as {
      ctx: { tenantId: string; role: string; isService?: boolean };
    };
    expect(result.ctx.tenantId).toBe('tenant-42');
    expect(result.ctx.role).toBe('SERVICE');
    expect(result.ctx.isService).toBe(true);
  });

  it('rejects refresh tokens (wrong type)', () => {
    const { server, jwt } = buildServer();
    const refresh = jwt.sign({
      subject: 'u',
      tenantId: 't',
      membershipId: 'm',
      role: 'MEMBER',
      jti: 'j',
      type: 'refresh',
      ttlSeconds: 60,
    });
    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${refresh}`);
    expect(() => callAuth(server, md)).toThrow(/unexpected token type/);
  });
});
