import {
  Body,
  Controller,
  ForbiddenException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { AuthJwtService } from '../auth/jwt.service';
import {
  AssistantService,
  type AssistantRecapInput,
  type AssistantTurnInput,
} from './assistant.service';

@Controller('internal/assistant')
@Public()
@SkipThrottle()
export class AssistantInternalController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly jwt: AuthJwtService,
  ) {}

  @Post('turns')
  async saveTurn(@Body() body: AssistantTurnInput, @Req() req: Request) {
    this.assertServiceCaller(req);
    const turn = await this.assistant.saveTurn(body);
    return { ok: true, id: turn.id };
  }

  @Post('recap')
  async saveRecap(@Body() body: AssistantRecapInput, @Req() req: Request) {
    this.assertServiceCaller(req);
    const recap = await this.assistant.saveRecap(body);
    return { ok: true, id: recap.id };
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
        throw new UnauthorizedException('Invalid service token');
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
