import { Injectable } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';

import { logFeedbackTrace, makeFeedbackTraceId } from './feedback-trace';
import { mapPublishFeedbackRequest } from './feedback.mapper';
import { LLMFeedbackService } from '../llm-feedback/llm-feedback.service';
import { AuthJwtService } from '../auth/jwt.service';
import type { TenantContext } from '../tenancy/tenant-context.types';
import { TenantMismatchError } from '../tenancy/tenant-context.types';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

type UnaryCallback<T> = (error: grpc.ServiceError | null, response?: T) => void;

interface PublishFeedbackResponse {
  accepted: boolean;
  feedback_id: string;
  message: string;
}

interface AuthenticatedCall<TReq> {
  request: TReq;
  metadata: grpc.Metadata;
  user?: TenantContext;
}

/**
 * gRPC ingestion service.
 *
 * Authentication:
 *  - `authorization: Bearer <jwt>` MUST be present. Both user and service
 *    tokens are accepted — but the tenantId is ALWAYS derived from the
 *    token (`token.tid`).
 *  - `x-tenant-id` metadata is strictly optional. If present it MUST equal
 *    `token.tid`; mismatches are rejected with `PERMISSION_DENIED` and
 *    persisted in `AuditLog` for incident response.
 *
 * Context propagation follows the rules in docs/auth-architecture.md:
 *  - AsyncLocalStorage is NEVER used here. Streaming gRPC callbacks run in
 *    overlapping event-loop ticks across tenants, so the handler always
 *    passes `call.user.tenantId` explicitly to services.
 */
@Injectable()
export class FeedbackGrpcServer {
  constructor(
    private readonly llmFeedbackService: LLMFeedbackService,
    private readonly jwt: AuthJwtService,
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  getImplementation() {
    return {
      PublishFeedback: this.publishFeedback.bind(this),
    };
  }

  private authenticate(
    metadata: grpc.Metadata,
  ): { ctx: TenantContext; claimedTenantId: string | null } {
    const authValues = metadata.get('authorization');
    const authHeader =
      authValues.length > 0 ? String(authValues[0]).trim() : '';
    if (!authHeader) {
      throw Object.assign(new Error('missing authorization metadata'), {
        code: grpc.status.UNAUTHENTICATED,
      });
    }
    const [scheme, token] = authHeader.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
      throw Object.assign(new Error('invalid authorization scheme'), {
        code: grpc.status.UNAUTHENTICATED,
      });
    }
    let claims;
    try {
      // We accept both `access` (human user) and `service` tokens here.
      claims = this.jwt.verify(token);
    } catch (err) {
      throw Object.assign(
        new Error(err instanceof Error ? err.message : 'invalid token'),
        { code: grpc.status.UNAUTHENTICATED },
      );
    }
    if (claims.type !== 'access' && claims.type !== 'service') {
      throw Object.assign(new Error(`unexpected token type "${claims.type}"`), {
        code: grpc.status.UNAUTHENTICATED,
      });
    }

    const hint = metadata.get('x-tenant-id');
    const claimedTenantId =
      hint.length > 0 ? String(hint[0]).trim() || null : null;

    // Service tokens may act cross-tenant because a single backend-trusted
    // worker (e.g. the transcription pipeline) ingests events for many tenants.
    // For those, `x-tenant-id` is MANDATORY and becomes the effective tenant.
    // For human access tokens the token's `tid` is authoritative; any claim
    // must match or we deny and audit.
    if (claims.type === 'service' && claims.role === 'SERVICE') {
      if (!claimedTenantId) {
        throw Object.assign(
          new Error('service tokens require x-tenant-id metadata'),
          { code: grpc.status.UNAUTHENTICATED },
        );
      }
      const ctx: TenantContext = Object.freeze({
        userId: claims.sub,
        tenantId: claimedTenantId,
        role: 'SERVICE',
        jti: claims.jti,
        isService: true,
      });
      return { ctx, claimedTenantId };
    }

    const ctx: TenantContext = Object.freeze({
      userId: claims.sub,
      tenantId: claims.tid,
      role: claims.role,
      jti: claims.jti,
      isService: claims.type === 'service',
    });

    if (claimedTenantId && claimedTenantId !== ctx.tenantId) {
      void this.logTenantMismatch(ctx, claimedTenantId).catch(() => undefined);
      throw Object.assign(
        new TenantMismatchError(ctx.tenantId, claimedTenantId),
        { code: grpc.status.PERMISSION_DENIED },
      );
    }
    return { ctx, claimedTenantId };
  }

  async publishFeedback(
    call: AuthenticatedCall<
      Parameters<typeof mapPublishFeedbackRequest>[0]
    > & { metadata: grpc.Metadata },
    callback: UnaryCallback<PublishFeedbackResponse>,
  ) {
    let ctx: TenantContext;
    try {
      ({ ctx: call.user } = this.authenticate(call.metadata));
      ctx = call.user as TenantContext;
    } catch (err) {
      const code = (err as { code?: number }).code ?? grpc.status.INTERNAL;
      const message = err instanceof Error ? err.message : 'unknown auth error';
      console.warn(`[FeedbackGrpcServer] auth rejected: ${message}`);
      callback({
        name: 'FeedbackAuthError',
        message,
        code,
      } as grpc.ServiceError);
      return;
    }

    try {
      const tIngressStartMs = Date.now();
      const ingressEvent = mapPublishFeedbackRequest(call.request, ctx.tenantId);

      // Validate claim mismatch inside the payload as well — defence in depth.
      if (
        ingressEvent.claimedTenantId &&
        ingressEvent.claimedTenantId !== ctx.tenantId
      ) {
        void this.logTenantMismatch(ctx, ingressEvent.claimedTenantId).catch(
          () => undefined,
        );
        throw Object.assign(
          new TenantMismatchError(ctx.tenantId, ingressEvent.claimedTenantId),
          { code: grpc.status.PERMISSION_DENIED },
        );
      }

      const windowEndMs = ingressEvent.windowEnd.getTime();
      const traceId = makeFeedbackTraceId(
        ingressEvent.meetingId,
        ingressEvent.participantId,
        windowEndMs,
      );

      console.log(
        `[Step 7] Recebido payload do LLM via gRPC | tenant=${ctx.tenantId} | reunião=${ingressEvent.meetingId}`,
      );
      await this.llmFeedbackService.handleIngress(ingressEvent);

      const tIngressEndMs = Date.now();
      const windowEndToBackendMs =
        Number.isFinite(windowEndMs) && windowEndMs > 0
          ? tIngressEndMs - windowEndMs
          : null;

      logFeedbackTrace('backend.ingress', {
        traceId,
        meetingId: ingressEvent.meetingId,
        participantId: ingressEvent.participantId,
        windowEndMs,
        transcriptChars: ingressEvent.text.length,
        hasDirectFeedback: !!ingressEvent.analysis.directFeedback,
        handleMs: tIngressEndMs - tIngressStartMs,
        windowEndToBackendMs,
      });

      callback(null, {
        accepted: true,
        feedback_id: '',
        message: 'Accepted LLM feedback event',
      });
    } catch (error) {
      const code = (error as { code?: number }).code ?? grpc.status.INTERNAL;
      const message =
        error instanceof Error ? error.message : 'Unknown feedback error';
      console.error(
        `Failed to publish feedback via gRPC (tenant=${ctx.tenantId}): ${message}`,
      );
      callback({
        name: 'FeedbackPublishError',
        message,
        code,
      } as grpc.ServiceError);
    }
  }

  private async logTenantMismatch(
    ctx: TenantContext,
    claimedTenantId: string,
  ): Promise<void> {
    await this.tenantCtx.runWithTenantBypass(async () => {
      await this.prisma.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          // Primary action key follows the plan (`tenant_mismatch`). The
          // transport/rpc is captured in `target` so dashboards can filter
          // by action across HTTP / Socket.IO / WS / gRPC uniformly.
          action: 'tenant_mismatch',
          target: 'grpc:FeedbackIngestionService.PublishFeedback',
          metadata: {
            claimedTenantId,
            jti: ctx.jti,
            transport: 'grpc',
          } as any,
        },
      });
    });
  }
}
