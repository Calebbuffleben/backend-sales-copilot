import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { AuthJwtService } from '../auth/jwt.service';
import { PlaybookTemplatesService } from './playbook-templates.service';

/**
 * Internal catalog for python-service Live sessions.
 * Auth: SERVICE_BOOTSTRAP_KEY (header) or Bearer service JWT — not AdminOnly.
 */
@Controller('internal/playbooks')
@Public()
@SkipThrottle()
export class PlaybooksInternalController {
  constructor(
    private readonly templates: PlaybookTemplatesService,
    private readonly jwt: AuthJwtService,
  ) {}

  @Get('catalog')
  async catalog(
    @Query('tenantId') tenantId: string | undefined,
    @Req() req: Request,
  ) {
    this.assertServiceCaller(req);

    const tid = (tenantId || '').trim();
    if (!tid) {
      throw new UnauthorizedException('tenantId query param required');
    }

    const rows = await this.templates.list(tid);
    return {
      templates: rows.map((r) => ({
        key: r.key,
        title: r.title,
        description: r.description,
        steps: r.steps,
      })),
    };
  }

  private assertServiceCaller(req: Request): void {
    const expected = process.env.SERVICE_BOOTSTRAP_KEY || '';
    const bootstrap =
      (req.headers['x-service-bootstrap-key'] as string | undefined) || '';

    if (expected && bootstrap && constantTimeEquals(expected, bootstrap)) {
      return;
    }

    const bearer = extractBearer(
      req.headers['authorization'] as string | undefined,
    );
    if (bearer) {
      try {
        const claims = this.jwt.verify(bearer, 'service');
        if (claims.type === 'service' && claims.role === 'SERVICE') {
          return;
        }
      } catch {
        // fall through
      }
    }

    throw new ForbiddenException('Service auth required');
  }
}

function extractBearer(header: string | undefined): string {
  if (!header) return '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return '';
  return token.trim();
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
