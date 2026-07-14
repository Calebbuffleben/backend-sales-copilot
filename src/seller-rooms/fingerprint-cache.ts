import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

/** Ephemeral fingerprint micro-batch cache (never logs feature bytes). */
@Injectable()
export class FingerprintCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(FingerprintCacheService.name);
  private client: RedisClientType | null = null;
  private connecting: Promise<void> | null = null;

  async onModuleDestroy() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }

  isRequired(): boolean {
    return Boolean(process.env.REDIS_URL?.trim());
  }

  async ensureConnected(): Promise<boolean> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) {
      return false;
    }
    if (this.client?.isOpen) {
      return true;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = createClient({ url }) as RedisClientType;
        client.on('error', (err) => {
          this.logger.warn(`Redis fingerprint cache error: ${err.message}`);
        });
        await client.connect();
        this.client = client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    try {
      await this.connecting;
      return Boolean(this.client?.isOpen);
    } catch (err) {
      this.logger.warn(
        `Failed to connect fingerprint Redis: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private fpKey(tenantId: string, roomId: string, userId: string) {
    return `sr:fp:${tenantId}:${roomId}:${userId}`;
  }

  private presenceKey(tenantId: string, roomId: string) {
    return `sr:presence:${tenantId}:${roomId}`;
  }

  private lastSeqKey(tenantId: string, roomId: string, userId: string) {
    return `sr:lastseq:${tenantId}:${roomId}:${userId}`;
  }

  async setMicroBatch(
    tenantId: string,
    roomId: string,
    userId: string,
    payload: Buffer,
    ttlSec = 3,
  ): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    await this.client.set(
      this.fpKey(tenantId, roomId, userId),
      payload.toString('base64'),
      { EX: ttlSec },
    );
  }

  async getMicroBatch(
    tenantId: string,
    roomId: string,
    userId: string,
  ): Promise<Buffer | null> {
    if (!(await this.ensureConnected()) || !this.client) return null;
    const value = await this.client.get(
      this.fpKey(tenantId, roomId, userId),
    );
    if (value == null) return null;
    return Buffer.from(String(value), 'base64');
  }

  async getSnapshot(
    tenantId: string,
    roomId: string,
    userIds: string[],
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const userId of userIds) {
      const buf = await this.getMicroBatch(tenantId, roomId, userId);
      if (buf) {
        out[userId] = buf.toString('base64');
      }
    }
    return out;
  }

  async setPresence(
    tenantId: string,
    roomId: string,
    userId: string,
    socketId: string,
    ttlSec = 30,
  ): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    const key = this.presenceKey(tenantId, roomId);
    await this.client.hSet(
      key,
      userId,
      JSON.stringify({ socketId, lastHeartbeat: Date.now() }),
    );
    await this.client.expire(key, ttlSec);
  }

  async removePresence(
    tenantId: string,
    roomId: string,
    userId: string,
  ): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    await this.client.hDel(this.presenceKey(tenantId, roomId), userId);
  }

  async getPresence(
    tenantId: string,
    roomId: string,
  ): Promise<Record<string, { socketId: string; lastHeartbeat: number }>> {
    if (!(await this.ensureConnected()) || !this.client) return {};
    const raw = await this.client.hGetAll(this.presenceKey(tenantId, roomId));
    const out: Record<string, { socketId: string; lastHeartbeat: number }> = {};
    for (const [userId, value] of Object.entries(raw)) {
      try {
        out[userId] = JSON.parse(value) as {
          socketId: string;
          lastHeartbeat: number;
        };
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  async getLastSeq(
    tenantId: string,
    roomId: string,
    userId: string,
  ): Promise<number> {
    if (!(await this.ensureConnected()) || !this.client) return -1;
    const value = await this.client.get(
      this.lastSeqKey(tenantId, roomId, userId),
    );
    if (value == null) return -1;
    const n = Number(value);
    return Number.isFinite(n) ? n : -1;
  }

  async setLastSeq(
    tenantId: string,
    roomId: string,
    userId: string,
    seq: number,
  ): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    await this.client.set(
      this.lastSeqKey(tenantId, roomId, userId),
      String(seq),
      { EX: 60 * 60 * 6 },
    );
  }

  async purgeRoom(
    tenantId: string,
    roomId: string,
    memberIds?: string[],
  ): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    const presence = await this.getPresence(tenantId, roomId);
    const userIds = new Set([
      ...Object.keys(presence),
      ...(memberIds ?? []),
    ]);
    const keys = [this.presenceKey(tenantId, roomId)];
    for (const userId of userIds) {
      keys.push(this.fpKey(tenantId, roomId, userId));
      keys.push(this.lastSeqKey(tenantId, roomId, userId));
    }
    if (keys.length > 0) {
      await this.client.del(keys);
    }
  }
}
