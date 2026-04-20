import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth.constants';

/** Restrict a route to the given roles. Combine with the global JwtAuthGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
