import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

import type { MeetingSnapshot } from './monitor.types';

const SNAP_TTL_SEC = 600;

@Injectable()
export class MonitorSnapshotStore implements OnModuleDestroy {
  private readonly logger = new Logger(MonitorSnapshotStore.name);
  private client: RedisClientType | null = null;
  private connecting: Promise<void> | null = null;
  private readonly memory = new Map<string, MeetingSnapshot>();

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

  private snapKey(tenantId: string, meetingId: string) {
    return `monitor:snap:${tenantId}:${meetingId}`;
  }

  async set(snapshot: MeetingSnapshot): Promise<void> {
    const key = this.snapKey(snapshot.tenantId, snapshot.meetingId);
    this.memory.set(key, snapshot);
    if (!(await this.ensureConnected()) || !this.client) return;
    try {
      await this.client.set(key, JSON.stringify(snapshot), { EX: SNAP_TTL_SEC });
    } catch (err) {
      this.logger.warn(
        `snapshot redis set failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async get(tenantId: string, meetingId: string): Promise<MeetingSnapshot | null> {
    const key = this.snapKey(tenantId, meetingId);
    if (await this.ensureConnected() && this.client) {
      try {
        const raw = await this.client.get(key);
        if (raw) return JSON.parse(raw) as MeetingSnapshot;
      } catch (err) {
        this.logger.warn(
          `snapshot redis get failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return this.memory.get(key) ?? null;
  }

  async getMany(
    tenantId: string,
    meetingIds: string[],
  ): Promise<Map<string, MeetingSnapshot>> {
    const out = new Map<string, MeetingSnapshot>();
    await Promise.all(
      meetingIds.map(async (meetingId) => {
        const snap = await this.get(tenantId, meetingId);
        if (snap) out.set(meetingId, snap);
      }),
    );
    return out;
  }

  async publishFeedbackBroadcast(payload: {
    tenantId: string;
    meetingId: string;
    text: string;
  }): Promise<void> {
    if (!(await this.ensureConnected()) || !this.client) return;
    try {
      await this.client.publish('feedback:broadcast', JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(
        `whisper redis publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureConnected(): Promise<boolean> {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return false;
    if (this.client?.isOpen) return true;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = createClient({ url }) as RedisClientType;
        client.on('error', (err) => {
          this.logger.warn(`Monitor Redis error: ${err.message}`);
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
        `Failed to connect monitor Redis: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
