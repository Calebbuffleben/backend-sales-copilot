import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SellerRoomStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { FingerprintCacheService } from './fingerprint-cache';
import { FingerprintSyncGateway } from './fingerprint-sync.gateway';

const IDLE_TIMEOUT_MS = Number(
  process.env.SELLER_ROOM_IDLE_TIMEOUT_MS || 60_000,
);
const ARCHIVE_AFTER_MS = Number(
  process.env.SELLER_ROOM_ARCHIVE_AFTER_MS || 24 * 60 * 60 * 1000,
);
const TICK_MS = Number(process.env.SELLER_ROOM_LIFECYCLE_TICK_MS || 15_000);

/**
 * Idle auto-end (empty presence ≥ 60s) and ENDED → ARCHIVED retention.
 * Uses a process timer (no @nestjs/schedule dependency).
 */
@Injectable()
export class SellerRoomsLifecycleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SellerRoomsLifecycleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FingerprintCacheService,
    private readonly syncGateway: FingerprintSyncGateway,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.warn(
          `Seller room lifecycle tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, TICK_MS);
    this.timer.unref?.();
    this.logger.log(
      `Seller room lifecycle enabled | idleMs=${IDLE_TIMEOUT_MS} | archiveMs=${ARCHIVE_AFTER_MS} | tickMs=${TICK_MS}`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ ended: number; archived: number }> {
    const ended = await this.endIdleRooms();
    const archived = await this.archiveEndedRooms();
    return { ended, archived };
  }

  private async endIdleRooms(): Promise<number> {
    const rooms = await this.prisma.sellerRoom.findMany({
      where: {
        // Only ACTIVE rooms can idle-end; OPEN rooms waiting for first join are kept.
        status: SellerRoomStatus.ACTIVE,
      },
      select: {
        id: true,
        tenantId: true,
        updatedAt: true,
        members: {
          where: { status: 'JOINED' },
          select: { userId: true },
        },
      },
      take: 200,
    });

    let ended = 0;
    const now = Date.now();
    for (const room of rooms) {
      const presence = await this.cache.getPresence(room.tenantId, room.id);
      const online = Object.keys(presence).length;
      if (online > 0) continue;

      // No Socket.IO presence: require the room to be idle long enough after last DB update.
      const idleMs = now - room.updatedAt.getTime();
      if (idleMs < IDLE_TIMEOUT_MS) continue;

      await this.prisma.sellerRoom.update({
        where: { id: room.id },
        data: {
          status: SellerRoomStatus.ENDED,
          endedAt: new Date(),
        },
      });
      await this.cache.purgeRoom(
        room.tenantId,
        room.id,
        room.members.map((m) => m.userId),
      );
      this.syncGateway.emitRoomEnded(room.tenantId, room.id, 'idle_timeout');
      ended += 1;
      this.logger.log(
        `Auto-ended idle seller room | tenant=${room.tenantId} room=${room.id} idleMs=${idleMs}`,
      );
    }
    return ended;
  }

  private async archiveEndedRooms(): Promise<number> {
    const cutoff = new Date(Date.now() - ARCHIVE_AFTER_MS);
    const result = await this.prisma.sellerRoom.updateMany({
      where: {
        status: SellerRoomStatus.ENDED,
        endedAt: { lte: cutoff },
      },
      data: { status: SellerRoomStatus.ARCHIVED },
    });
    if (result.count > 0) {
      this.logger.log(`Archived ${result.count} ended seller rooms`);
    }
    return result.count;
  }
}
