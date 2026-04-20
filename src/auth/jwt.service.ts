import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';

export type JwtTokenType = 'access' | 'refresh' | 'service';

export interface BaseJwtClaims {
  sub: string;
  tid: string;
  role: UserRole;
  jti: string;
  type: JwtTokenType;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

export interface SignOptions {
  subject: string;
  tenantId: string;
  role: UserRole;
  jti: string;
  type: JwtTokenType;
  ttlSeconds: number;
}

/**
 * Central token signer/verifier.
 *
 * Prefers RS256 with `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`. Falls back to
 * HS256 with `JWT_SECRET` only when `NODE_ENV !== 'production'` and RS
 * keys are missing. In production, RS256 keys are REQUIRED.
 */
@Injectable()
export class AuthJwtService {
  private readonly logger = new Logger(AuthJwtService.name);
  private readonly algorithm: jwt.Algorithm;
  private readonly signKey: string;
  private readonly verifyKey: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor() {
    const privateKey = readKeyEnv('JWT_PRIVATE_KEY');
    const publicKey = readKeyEnv('JWT_PUBLIC_KEY');
    const hmacSecret = process.env.JWT_SECRET?.trim();
    const isProd = process.env.NODE_ENV === 'production';

    if (privateKey && publicKey) {
      this.algorithm = 'RS256';
      this.signKey = privateKey;
      this.verifyKey = publicKey;
    } else if (!isProd && hmacSecret) {
      this.logger.warn(
        '[AuthJwtService] Using HS256 dev fallback. Set JWT_PRIVATE_KEY + JWT_PUBLIC_KEY for production.',
      );
      this.algorithm = 'HS256';
      this.signKey = hmacSecret;
      this.verifyKey = hmacSecret;
    } else {
      throw new Error(
        'JWT keys missing: set JWT_PRIVATE_KEY + JWT_PUBLIC_KEY (RS256) or JWT_SECRET (HS256, non-prod only).',
      );
    }

    this.issuer = process.env.JWT_ISSUER?.trim() || 'meet-backend';
    this.audience = process.env.JWT_AUDIENCE?.trim() || 'meet-platform';
  }

  sign(opts: SignOptions): string {
    const payload: Omit<BaseJwtClaims, 'iat' | 'exp'> = {
      sub: opts.subject,
      tid: opts.tenantId,
      role: opts.role,
      jti: opts.jti,
      type: opts.type,
      iss: this.issuer,
      aud: this.audience,
    };
    return jwt.sign(payload, this.signKey, {
      algorithm: this.algorithm,
      expiresIn: opts.ttlSeconds,
    });
  }

  verify(token: string, expectedType?: JwtTokenType): BaseJwtClaims {
    let decoded: jwt.JwtPayload | string;
    try {
      decoded = jwt.verify(token, this.verifyKey, {
        algorithms: [this.algorithm],
        issuer: this.issuer,
        audience: this.audience,
      });
    } catch (err) {
      throw new Error(
        `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof decoded === 'string' || !decoded || typeof decoded !== 'object') {
      throw new Error('JWT payload is not an object');
    }
    const claims = decoded as BaseJwtClaims;
    if (!claims.sub || !claims.tid || !claims.role || !claims.jti || !claims.type) {
      throw new Error('JWT payload missing required claims (sub/tid/role/jti/type)');
    }
    if (expectedType && claims.type !== expectedType) {
      throw new Error(
        `Unexpected token type: got "${claims.type}", want "${expectedType}"`,
      );
    }
    return claims;
  }
}

function readKeyEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  // Support escaped newlines (\n) for env-based PEM delivery.
  return raw.replace(/\\n/g, '\n').trim() || null;
}
