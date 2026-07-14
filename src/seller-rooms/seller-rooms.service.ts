import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SellerRoomInvitationStatus,
  SellerRoomMemberStatus,
  SellerRoomStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { CreateSellerRoomDto } from './dto/seller-rooms.dto';
import { FingerprintCacheService } from './fingerprint-cache';
import { randomBytes } from 'crypto';

const MAX_MEMBERS_PER_ROOM = 10;
const MAX_ACTIVE_ROOMS_PER_TENANT = 5;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SellerRoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FingerprintCacheService,
  ) {}

  async create(tenantId: string, userId: string, dto: CreateSellerRoomDto) {
    const activeCount = await this.prisma.sellerRoom.count({
      where: {
        tenantId,
        status: { in: [SellerRoomStatus.OPEN, SellerRoomStatus.ACTIVE] },
      },
    });
    if (activeCount >= MAX_ACTIVE_ROOMS_PER_TENANT) {
      throw new BadRequestException(
        `Tenant already has ${MAX_ACTIVE_ROOMS_PER_TENANT} open/active seller rooms`,
      );
    }

    return this.prisma.sellerRoom.create({
      data: {
        tenantId,
        meetingId: dto.meetingId.trim(),
        name: dto.name.trim(),
        meetUrl: dto.meetUrl?.trim() || null,
        createdById: userId,
        status: SellerRoomStatus.OPEN,
        metadata: {
          fingerprintVersion: 'logmel_mfcc_v1',
          // Ephemeral projection seed — never log; discarded on ENDED via Redis purge.
          projectionSeed: randomBytes(16).toString('hex'),
        },
        members: {
          create: {
            userId,
            status: SellerRoomMemberStatus.JOINED,
            joinedAt: new Date(),
          },
        },
      },
      include: this.roomInclude(),
    });
  }

  async list(tenantId: string, userId: string) {
    const rooms = await this.prisma.sellerRoom.findMany({
      where: {
        tenantId,
        OR: [
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: this.roomInclude(),
    });

    return Promise.all(
      rooms.map(async (room) => {
        const myMember = room.members.find((m) => m.userId === userId);
        const presence =
          room.status === SellerRoomStatus.OPEN ||
          room.status === SellerRoomStatus.ACTIVE
            ? await this.cache.getPresence(tenantId, room.id)
            : {};
        const onlineUserIds = Object.keys(presence);
        const pendingInviteForMe = room.invitations.find(
          (inv) =>
            inv.inviteeId === userId &&
            inv.status === SellerRoomInvitationStatus.PENDING,
        );
        return {
          ...room,
          myMemberStatus: myMember?.status ?? null,
          isCreator: room.createdById === userId,
          onlineUserIds,
          onlineCount: onlineUserIds.length,
          iAmOnline: Boolean(presence[userId]),
          pendingInvitationId: pendingInviteForMe?.id ?? null,
        };
      }),
    );
  }

  async get(tenantId: string, userId: string, roomId: string) {
    const room = await this.findAccessibleRoom(tenantId, userId, roomId);
    return room;
  }

  async invite(
    tenantId: string,
    invitedById: string,
    roomId: string,
    inviteeEmail: string,
  ) {
    const room = await this.findAccessibleRoom(tenantId, invitedById, roomId);
    if (
      room.status === SellerRoomStatus.ENDED ||
      room.status === SellerRoomStatus.ARCHIVED
    ) {
      throw new BadRequestException('Cannot invite to an ended room');
    }
    if (room.createdById !== invitedById) {
      const membership = room.members.find((m) => m.userId === invitedById);
      if (!membership || membership.status !== SellerRoomMemberStatus.JOINED) {
        throw new ForbiddenException('Only joined members can invite');
      }
    }

    const memberCount = room.members.filter(
      (m) => m.status !== SellerRoomMemberStatus.LEFT,
    ).length;
    if (memberCount >= MAX_MEMBERS_PER_ROOM) {
      throw new BadRequestException(
        `Seller room already has ${MAX_MEMBERS_PER_ROOM} members`,
      );
    }

    const normalizedEmail = inviteeEmail.trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
      throw new BadRequestException('Invalid email');
    }

    const inviteeUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });
    if (!inviteeUser) {
      throw new BadRequestException(
        'No user found with this email. They must already be a member of this tenant.',
      );
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId: inviteeUser.id, tenantId } },
    });
    if (!membership) {
      throw new BadRequestException('Invitee is not a member of this tenant');
    }

    const inviteeId = inviteeUser.id;
    const existingMember = room.members.find((m) => m.userId === inviteeId);
    if (existingMember?.status === SellerRoomMemberStatus.JOINED) {
      throw new BadRequestException('User is already a joined member');
    }

    const invitation = await this.prisma.sellerRoomInvitation.create({
      data: {
        sellerRoomId: roomId,
        inviteeId,
        invitedById,
        status: SellerRoomInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    await this.prisma.sellerRoomMember.upsert({
      where: {
        sellerRoomId_userId: { sellerRoomId: roomId, userId: inviteeId },
      },
      create: {
        sellerRoomId: roomId,
        userId: inviteeId,
        status: SellerRoomMemberStatus.INVITED,
      },
      update: {
        status: SellerRoomMemberStatus.INVITED,
        leftAt: null,
      },
    });

    return invitation;
  }

  async acceptInvitation(
    tenantId: string,
    userId: string,
    invitationId: string,
  ) {
    const invitation = await this.prisma.sellerRoomInvitation.findFirst({
      where: { id: invitationId, inviteeId: userId },
      include: { sellerRoom: true },
    });
    if (!invitation || invitation.sellerRoom.tenantId !== tenantId) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== SellerRoomInvitationStatus.PENDING) {
      throw new BadRequestException('Invitation is not pending');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      await this.prisma.sellerRoomInvitation.update({
        where: { id: invitationId },
        data: { status: SellerRoomInvitationStatus.EXPIRED },
      });
      throw new BadRequestException('Invitation expired');
    }
    if (
      invitation.sellerRoom.status === SellerRoomStatus.ENDED ||
      invitation.sellerRoom.status === SellerRoomStatus.ARCHIVED
    ) {
      throw new BadRequestException('Seller room has ended');
    }

    await this.prisma.$transaction([
      this.prisma.sellerRoomInvitation.update({
        where: { id: invitationId },
        data: {
          status: SellerRoomInvitationStatus.ACCEPTED,
          acceptedAt: new Date(),
        },
      }),
      this.prisma.sellerRoomMember.upsert({
        where: {
          sellerRoomId_userId: {
            sellerRoomId: invitation.sellerRoomId,
            userId,
          },
        },
        create: {
          sellerRoomId: invitation.sellerRoomId,
          userId,
          status: SellerRoomMemberStatus.JOINED,
          joinedAt: new Date(),
        },
        update: {
          status: SellerRoomMemberStatus.JOINED,
          joinedAt: new Date(),
          leftAt: null,
        },
      }),
      this.prisma.sellerRoom.updateMany({
        where: {
          id: invitation.sellerRoomId,
          tenantId,
          status: SellerRoomStatus.OPEN,
        },
        data: {
          status: SellerRoomStatus.ACTIVE,
          startedAt: new Date(),
        },
      }),
    ]);

    return this.findAccessibleRoom(tenantId, userId, invitation.sellerRoomId);
  }

  async join(tenantId: string, userId: string, roomId: string) {
    const room = await this.findAccessibleRoom(tenantId, userId, roomId);
    if (
      room.status === SellerRoomStatus.ENDED ||
      room.status === SellerRoomStatus.ARCHIVED
    ) {
      throw new BadRequestException('Seller room has ended');
    }

    await this.prisma.sellerRoomMember.upsert({
      where: { sellerRoomId_userId: { sellerRoomId: roomId, userId } },
      create: {
        sellerRoomId: roomId,
        userId,
        status: SellerRoomMemberStatus.JOINED,
        joinedAt: new Date(),
      },
      update: {
        status: SellerRoomMemberStatus.JOINED,
        joinedAt: new Date(),
        leftAt: null,
      },
    });

    if (room.status === SellerRoomStatus.OPEN) {
      await this.prisma.sellerRoom.update({
        where: { id: roomId },
        data: { status: SellerRoomStatus.ACTIVE, startedAt: new Date() },
      });
    }

    return this.findAccessibleRoom(tenantId, userId, roomId);
  }

  async leave(tenantId: string, userId: string, roomId: string) {
    await this.findAccessibleRoom(tenantId, userId, roomId);
    await this.prisma.sellerRoomMember.updateMany({
      where: { sellerRoomId: roomId, userId },
      data: {
        status: SellerRoomMemberStatus.LEFT,
        leftAt: new Date(),
      },
    });
    return { ok: true as const };
  }

  async end(tenantId: string, userId: string, roomId: string) {
    const room = await this.findAccessibleRoom(tenantId, userId, roomId);
    if (room.createdById !== userId) {
      throw new ForbiddenException('Only the creator can end the room');
    }
    const updated = await this.prisma.sellerRoom.update({
      where: { id: roomId },
      data: {
        status: SellerRoomStatus.ENDED,
        endedAt: new Date(),
      },
      include: this.roomInclude(),
    });
    // Clear ephemeral projection seed from metadata without logging it.
    if (room.metadata && typeof room.metadata === 'object') {
      const meta = { ...(room.metadata as Record<string, unknown>) };
      delete meta.projectionSeed;
      await this.prisma.sellerRoom.update({
        where: { id: roomId },
        data: { metadata: meta as object },
      });
    }
    const memberIds = room.members.map((m) => m.userId);
    await this.cache.purgeRoom(tenantId, roomId, memberIds);
    return updated;
  }

  async assertJoinedMember(
    tenantId: string,
    userId: string,
    roomId: string,
  ): Promise<{ meetingId: string; status: SellerRoomStatus }> {
    const room = await this.prisma.sellerRoom.findFirst({
      where: { id: roomId, tenantId },
      include: {
        members: { where: { userId, status: SellerRoomMemberStatus.JOINED } },
      },
    });
    if (!room) {
      throw new NotFoundException('Seller room not found');
    }
    if (
      room.status === SellerRoomStatus.ENDED ||
      room.status === SellerRoomStatus.ARCHIVED
    ) {
      throw new BadRequestException('Seller room has ended');
    }
    if (room.members.length === 0) {
      throw new ForbiddenException('Not a joined member of this seller room');
    }
    return { meetingId: room.meetingId, status: room.status };
  }

  async listJoinedMemberIds(tenantId: string, roomId: string): Promise<string[]> {
    const room = await this.prisma.sellerRoom.findFirst({
      where: { id: roomId, tenantId },
      include: {
        members: {
          where: { status: SellerRoomMemberStatus.JOINED },
          select: { userId: true },
        },
      },
    });
    return room?.members.map((m) => m.userId) ?? [];
  }

  private async findAccessibleRoom(
    tenantId: string,
    userId: string,
    roomId: string,
  ) {
    const room = await this.prisma.sellerRoom.findFirst({
      where: {
        id: roomId,
        tenantId,
        OR: [
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
      include: this.roomInclude(),
    });
    if (!room) {
      throw new NotFoundException('Seller room not found');
    }
    return room;
  }

  private roomInclude() {
    return {
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
      invitations: {
        where: { status: SellerRoomInvitationStatus.PENDING },
        include: {
          invitee: { select: { id: true, email: true, name: true } },
          invitedBy: { select: { id: true, email: true, name: true } },
        },
      },
      createdBy: { select: { id: true, email: true, name: true } },
    } as const;
  }
}
