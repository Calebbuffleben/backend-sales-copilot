import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { AuthJwtService } from '../auth/jwt.service';
import { RegisterBuiltinSpecialistDto } from './dto/specialist.dto';
import { SpecialistsService } from './specialists.service';

@Controller('internal/specialists')
@Public()
@SkipThrottle()
export class SpecialistsInternalController {
  constructor(
    private readonly specialists: SpecialistsService,
    private readonly jwt: AuthJwtService,
  ) {}

  @Get('catalog')
  catalog(@Req() req: Request) {
    this.assertServiceCaller(req);
    return this.specialists.catalog();
  }

  @Post('register-builtins')
  registerBuiltins(
    @Req() req: Request,
    @Body() body: { specialists?: RegisterBuiltinSpecialistDto[] },
  ) {
    this.assertServiceCaller(req);
    return this.specialists.registerBuiltins(body.specialists ?? []);
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
