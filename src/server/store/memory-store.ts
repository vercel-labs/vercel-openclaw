import type { SingleMeta } from "@/shared/types";

type MemoryLock = {
  token: string;
  expiresAt: number;
};

export class MemoryStore {
  readonly name = "memory";

  private meta: SingleMeta | null = null;

  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  private readonly queues = new Map<string, string[]>();

  private readonly locks = new Map<string, MemoryLock>();

  async getMeta(): Promise<SingleMeta | null> {
    return this.meta ? structuredClone(this.meta) : null;
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    this.meta = structuredClone(meta);
  }

  async getValue<T>(key: string): Promise<T | null> {
    this.gc();
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.gc();
    this.values.set(key, {
      value: JSON.stringify(value),
      expiresAt: typeof ttlSeconds === "number" ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async deleteValue(key: string): Promise<void> {
    this.values.delete(key);
  }

  async enqueue(key: string, value: string): Promise<number> {
    this.gc();
    const queue = this.queues.get(key) ?? [];
    queue.push(value);
    this.queues.set(key, queue);
    return queue.length;
  }

  async dequeue(key: string): Promise<string | null> {
    this.gc();
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) {
      return null;
    }

    const value = queue.shift() ?? null;
    if (queue.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, queue);
    }
    return value;
  }

  async getQueueLength(key: string): Promise<number> {
    this.gc();
    return this.queues.get(key)?.length ?? 0;
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    this.gc();
    const existing = this.locks.get(key);
    if (existing) {
      return null;
    }

    const token = crypto.randomUUID();
    this.locks.set(key, {
      token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    return token;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    const current = this.locks.get(key);
    if (current?.token === token) {
      this.locks.delete(key);
    }
  }

  private gc(): void {
    const now = Date.now();
    for (const [key, value] of this.locks.entries()) {
      if (value.expiresAt <= now) {
        this.locks.delete(key);
      }
    }

    for (const [key, value] of this.values.entries()) {
      if (value.expiresAt !== null && value.expiresAt <= now) {
        this.values.delete(key);
      }
    }
  }
}
