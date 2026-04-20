/**
 * e2e tests for the /auth/* surface + tenant enforcement.
 *
 * These tests exercise the real HTTP stack (ValidationPipe, middleware,
 * guards, controller) but replace `PrismaService` with an in-memory fake
 * so the suite is hermetic and can run in CI without Postgres.
 *
 * Covered flows:
 *   - POST /auth/register (self-signup, first user becomes OWNER)
 *   - POST /auth/login (happy path + failure)
 *   - POST /auth/login lockout when threshold exceeded
 *   - POST /auth/refresh with rotation + reuse detection (family revocation)
 *   - GET  /auth/me requires Bearer
 *   - POST /auth/service-token protected by SERVICE_BOOTSTRAP_KEY
 *   - GET  /feedback/metrics refuses cross-tenant requests
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthModule } from '../src/auth/auth.module';
import { FeedbackModule } from '../src/feedback/feedback.module';
import { LLMFeedbackModule } from '../src/llm-feedback/llm-feedback.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { createInMemoryPrismaFake } from './helpers/prisma-fake';

describe('/auth (e2e)', () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createInMemoryPrismaFake>;

  const HMAC_SECRET = 'test-e2e-secret-value-change-me-1234567890';

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = HMAC_SECRET;
    process.env.JWT_ISSUER = 'meet-backend-test';
    process.env.JWT_AUDIENCE = 'meet-platform-test';
    process.env.ALLOW_SELF_SIGNUP = 'true';
    process.env.SERVICE_BOOTSTRAP_KEY = 'test-bootstrap-key-xyz';
    process.env.AUTH_LOCKOUT_EMAIL_THRESHOLD = '3';
    process.env.AUTH_LOCKOUT_IP_THRESHOLD = '100';
    process.env.AUTH_LOCKOUT_WINDOW_SECONDS = '300';
    // Disable the Prisma `JWT_PRIVATE_KEY` path so we can use HS256.
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  beforeEach(async () => {
    prisma = createInMemoryPrismaFake();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 1000 },
        ]),
        TenancyModule,
        PrismaModule,
        AuthModule,
        LLMFeedbackModule,
        FeedbackModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  // --------------------------------------------------------------------- //
  // register / login                                                      //
  // --------------------------------------------------------------------- //

  it('POST /auth/register creates OWNER + tenant on first signup', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'owner@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'acme',
        tenantName: 'Acme',
        name: 'Owner',
      })
      .expect(201);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('owner@acme.test');
    expect(res.body.user.role).toBe('OWNER');
    expect(res.body.tenant.slug).toBe('acme');
  });

  it('POST /auth/login rejects invalid credentials and counts failures', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'user@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'acme',
      })
      .expect(201);

    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'user@acme.test',
          password: 'wrong-password-wrong-password',
          tenantSlug: 'acme',
        })
        .expect(401);
    }

    // 4th attempt should now hit the lockout gate (threshold = 3).
    const locked = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'user@acme.test',
        password: 'Sup3rS3cret-passphrase', // correct password!
        tenantSlug: 'acme',
      })
      .expect(401);

    expect(String(locked.body.message || '')).toMatch(/too many/i);

    // Ensure we recorded an auth.login.lockout entry.
    const logs = prisma._dumpAuditLogs();
    expect(logs.some((l) => l.action === 'auth.login.lockout')).toBe(true);
  });

  // --------------------------------------------------------------------- //
  // refresh / reuse detection                                             //
  // --------------------------------------------------------------------- //

  it('POST /auth/refresh rotates token; reusing revoked token kills the family', async () => {
    const session = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'rotator@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'acme-rotate',
      })
      .expect(201)
      .then((r) => r.body);

    // First rotation: original -> newToken.
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200)
      .then((r) => r.body);

    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    // Reusing the original (now revoked) must fail AND revoke all family tokens.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);

    // The newly-rotated token should now also be revoked (family kill).
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotated.refreshToken })
      .expect(401);
  });

  // --------------------------------------------------------------------- //
  // /auth/me                                                              //
  // --------------------------------------------------------------------- //

  it('GET /auth/me requires Bearer, returns user+tenant on success', async () => {
    const session = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'me@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'acme-me',
      })
      .expect(201)
      .then((r) => r.body);

    await request(app.getHttpServer()).get('/auth/me').expect(401);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200)
      .then((r) => r.body);

    expect(me.user.email).toBe('me@acme.test');
    expect(me.tenant.slug).toBe('acme-me');
  });

  // --------------------------------------------------------------------- //
  // /auth/service-token                                                   //
  // --------------------------------------------------------------------- //

  it('POST /auth/service-token requires SERVICE_BOOTSTRAP_KEY', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'svc-owner@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'svc-tenant',
      })
      .expect(201);

    // No key
    await request(app.getHttpServer())
      .post('/auth/service-token')
      .send({ tenantSlug: 'svc-tenant' })
      .expect(403);

    // Wrong key
    await request(app.getHttpServer())
      .post('/auth/service-token')
      .set('x-service-bootstrap-key', 'nope')
      .send({ tenantSlug: 'svc-tenant' })
      .expect(403);

    // Correct key mints a service token
    const minted = await request(app.getHttpServer())
      .post('/auth/service-token')
      .set('x-service-bootstrap-key', 'test-bootstrap-key-xyz')
      .send({ tenantSlug: 'svc-tenant', label: 'python-service', ttlSeconds: 120 })
      .expect(200)
      .then((r) => r.body);

    expect(minted.token).toBeTruthy();
    expect(minted.tenantSlug).toBe('svc-tenant');
    expect(minted.expiresAt).toBeGreaterThan(Date.now());

    // Service tokens must NOT be usable as access tokens on HTTP.
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${minted.token}`)
      .expect(401);
  });

  // --------------------------------------------------------------------- //
  // cross-tenant isolation on /feedback/metrics                            //
  // --------------------------------------------------------------------- //

  it('GET /feedback/metrics refuses token-vs-header tenant mismatches', async () => {
    const a = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'a@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'tenant-a',
      })
      .expect(201)
      .then((r) => r.body);

    const b = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'b@acme.test',
        password: 'Sup3rS3cret-passphrase',
        tenantSlug: 'tenant-b',
      })
      .expect(201)
      .then((r) => r.body);

    // Token A calling with Tenant B in the header must be rejected by the
    // HTTP tenant-mismatch guard added in `TenantContextMiddleware`.
    await request(app.getHttpServer())
      .get('/feedback/metrics/mtg-x')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .set('x-tenant-id', b.tenant.id)
      .expect((res) => {
        if (res.status !== 403) {
          throw new Error(
            `Expected 403 cross-tenant rejection, got ${res.status}`,
          );
        }
      });

    // Same-tenant header should pass the auth/tenancy gate (the feedback
    // service may still 200/404/500 depending on data — we just assert it
    // is NOT a 401/403).
    const ok = await request(app.getHttpServer())
      .get('/feedback/metrics/mtg-x')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .set('x-tenant-id', a.tenant.id);
    expect([200, 404, 500]).toContain(ok.status);
  });
});
