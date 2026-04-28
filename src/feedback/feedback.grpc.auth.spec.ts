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
      tenant: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === 'tenant-inactive') {
            return { id: where.id, status: 'INACTIVE' };
          }
          if (where.id === 'tenant-missing') {
            return null;
          }
          return { id: where.id, status: 'ACTIVE' };
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
      authenticate: (m: grpc.Metadata) => Promise<unknown>;
    }).authenticate(metadata);

  it('rejects calls with no authorization metadata', async () => {
    const { server } = buildServer();
    const md = new grpc.Metadata();
    await expect(callAuth(server, md)).rejects.toThrow(
      /missing authorization metadata/,
    );
  });

  it('rejects calls with a non-Bearer scheme', async () => {
    const { server } = buildServer();
    const md = new grpc.Metadata();
    md.add('authorization', 'Basic abcd');
    await expect(callAuth(server, md)).rejects.toThrow(
      /invalid authorization scheme/,
    );
  });

  it('accepts an access token and derives tenantId from token.tid', async () => {
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
    const result = (await callAuth(server, md)) as {
      ctx: { tenantId: string; userId: string; isService?: boolean };
    };
    expect(result.ctx.userId).toBe('user-1');
    expect(result.ctx.tenantId).toBe('tenant-1');
    expect(result.ctx.isService).toBeFalsy();
  });

  it('accepts an access token when x-tenant-id matches (redundant hint)', async () => {
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
    const result = (await callAuth(server, md)) as { ctx: { tenantId: string } };
    expect(result.ctx.tenantId).toBe('tenant-1');
  });

  it('rejects access tokens when x-tenant-id does not match token.tid', async () => {
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
    await expect(callAuth(server, md)).rejects.toThrow(TenantMismatchError);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('service tokens REQUIRE x-tenant-id and adopt it as the effective tenant', async () => {
    const { server, jwt } = buildServer();
    const svcToken = jwt.sign({
      subject: 'python-pipeline',
      role: 'SERVICE',
      jti: 'svc-1',
      type: 'service',
      ttlSeconds: 120,
    });
    const mdMissing = new grpc.Metadata();
    mdMissing.add('authorization', `Bearer ${svcToken}`);
    await expect(callAuth(server, mdMissing)).rejects.toThrow(
      /service tokens require x-tenant-id/,
    );

    const md = new grpc.Metadata();
    md.add('authorization', `Bearer ${svcToken}`);
    md.add('x-tenant-id', 'tenant-42');
    const result = (await callAuth(server, md)) as {
      ctx: { tenantId: string; role: string; isService?: boolean };
    };
    expect(result.ctx.tenantId).toBe('tenant-42');
    expect(result.ctx.role).toBe('SERVICE');
    expect(result.ctx.isService).toBe(true);
  });

  it('rejects service tokens for missing or inactive tenants', async () => {
    const { server, jwt } = buildServer();
    const svcToken = jwt.sign({
      subject: 'python-pipeline',
      role: 'SERVICE',
      jti: 'svc-unknown',
      type: 'service',
      ttlSeconds: 120,
    });

    const mdMissingTenant = new grpc.Metadata();
    mdMissingTenant.add('authorization', `Bearer ${svcToken}`);
    mdMissingTenant.add('x-tenant-id', 'tenant-missing');
    await expect(callAuth(server, mdMissingTenant)).rejects.toThrow(
      /unknown or inactive tenant/,
    );

    const mdInactiveTenant = new grpc.Metadata();
    mdInactiveTenant.add('authorization', `Bearer ${svcToken}`);
    mdInactiveTenant.add('x-tenant-id', 'tenant-inactive');
    await expect(callAuth(server, mdInactiveTenant)).rejects.toThrow(
      /unknown or inactive tenant/,
    );
  });

  it('rejects service calls when payload tenant_id differs from x-tenant-id', async () => {
    const { server, jwt } = buildServer();
    const svcToken = jwt.sign({
      subject: 'python-pipeline',
      role: 'SERVICE',
      jti: 'svc-mismatch',
      type: 'service',
      ttlSeconds: 120,
    });
    const metadata = new grpc.Metadata();
    metadata.add('authorization', `Bearer ${svcToken}`);
    metadata.add('x-tenant-id', 'tenant-42');

    const callback = jest.fn();
    await server.publishFeedback(
      {
        metadata,
        request: {
          meeting_id: 'm1',
          participant_id: 'p1',
          feedback_type: 'text_analysis_ingress',
          severity: 'info',
          ts_ms: 1,
          window_start_ms: 1,
          window_end_ms: 2,
          message: 'msg',
          transcript_text: 'hello',
          tenant_id: 'tenant-other',
          analysis: { direct_feedback: 'feedback' },
        },
      } as any,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
  });

  it('rejects refresh tokens (wrong type)', async () => {
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
    await expect(callAuth(server, md)).rejects.toThrow(/unexpected token type/);
  });
});
