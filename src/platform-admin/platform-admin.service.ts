import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InviteStatus,
  MembershipRole,
  Prisma,
  TenantStatus,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CreatePlatformInvitationDto,
  InviteListQueryDto,
  TenantListQueryDto,
  UpdateTenantDto,
  UserListQueryDto,
} from './dto/platform-admin.dto';

const DEFAULT_LIMIT = 25;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PlatformAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  listTenants(query: TenantListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.TenantWhereInput = {
        status: query.status,
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { slug: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.tenant.count({ where }),
        this.prisma.tenant.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            subscription: true,
            _count: {
              select: {
                memberships: true,
                invitations: true,
                sessions: true,
                feedbackEvents: true,
              },
            },
          },
        }),
      ]);
      return { total, items };
    });
  }

  getTenant(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id },
        include: {
          subscription: true,
          memberships: {
            include: { user: { select: { id: true, email: true, name: true } } },
            orderBy: { createdAt: 'asc' },
          },
          invitations: { orderBy: { createdAt: 'desc' }, take: 50 },
          _count: {
            select: { sessions: true, feedbackEvents: true },
          },
        },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      return tenant;
    });
  }

  updateTenant(id: string, dto: UpdateTenantDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const tenant = await this.prisma.tenant.update({
        where: { id },
        data: {
          ...(dto.status ? { status: dto.status } : {}),
          ...(dto.name ? { name: dto.name.trim() } : {}),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: id,
          action: 'platform.tenant.updated',
          target: id,
          metadata: dto as unknown as Prisma.InputJsonValue,
        },
      });
      return tenant;
    });
  }

  listUsers(query: UserListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.UserWhereInput = {
        ...(query.q
          ? {
              OR: [
                { email: { contains: query.q, mode: 'insensitive' } },
                { name: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.tenantId || query.role
          ? {
              memberships: {
                some: {
                  ...(query.tenantId ? { tenantId: query.tenantId } : {}),
                  ...(query.role ? { role: query.role } : {}),
                },
              },
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.user.count({ where }),
        this.prisma.user.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
            memberships: {
              include: { tenant: { select: { id: true, slug: true, name: true } } },
            },
          },
        }),
      ]);
      return { total, items };
    });
  }

  getUser(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const user = await this.prisma.user.findUnique({
        where: { id },
        include: {
          memberships: {
            include: { tenant: { select: { id: true, slug: true, name: true, status: true } } },
          },
        },
      });
      if (!user) throw new NotFoundException('User not found');
      return user;
    });
  }

  listInvites(query: InviteListQueryDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const { skip, take } = page(query.page, query.limit);
      const where: Prisma.InvitationWhereInput = {
        tenantId: query.tenantId,
        status: query.status,
        ...(query.q
          ? { email: { contains: query.q, mode: 'insensitive' } }
          : {}),
      };
      const [total, items] = await Promise.all([
        this.prisma.invitation.count({ where }),
        this.prisma.invitation.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: 'desc' },
          include: {
            tenant: { select: { id: true, slug: true, name: true } },
            invitedBy: { select: { id: true, email: true, name: true } },
          },
        }),
      ]);
      return { total, items };
    });
  }

  createInvite(tenantId: string, dto: CreatePlatformInvitationDto) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const normalizedEmail = dto.email.trim().toLowerCase();
      if (!normalizedEmail.includes('@')) {
        throw new BadRequestException('Invalid email');
      }
      const inviter = await this.prisma.membership.findFirst({
        where: { tenantId, role: { in: [MembershipRole.OWNER, MembershipRole.ADMIN] } },
        orderBy: { createdAt: 'asc' },
      });
      if (!inviter) {
        throw new NotFoundException('Tenant has no admin member to own invite');
      }
      const token = randomBytes(32).toString('base64url');
      const invite = await this.prisma.invitation.create({
        data: {
          tenantId,
          email: normalizedEmail,
          role: dto.role ?? MembershipRole.MEMBER,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          invitedById: inviter.userId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          action: 'platform.invite.created',
          target: invite.id,
          metadata: { email: normalizedEmail, role: invite.role },
        },
      });
      return { ...invite, token };
    });
  }

  revokeInvite(id: string) {
    return this.tenantCtx.runWithTenantBypass(async () => {
      const invite = await this.prisma.invitation.update({
        where: { id },
        data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: invite.tenantId,
          action: 'platform.invite.revoked',
          target: invite.id,
        },
      });
      return invite;
    });
  }
}

function page(pageNumber = 1, limit = DEFAULT_LIMIT) {
  const take = Math.min(Math.max(limit, 1), 200);
  const current = Math.max(pageNumber, 1);
  return { skip: (current - 1) * take, take };
}
