import type { SingleMeta } from "@/shared/types";

type MemoryLock = {
  token: string;
  expiresAt: number;
};

export class MemoryStore {
  readonly name = "memory";

  private meta: SingleMeta | null = null;

  private readonly locks = new Map<string, MemoryLock>();

  async getMeta(): Promise<SingleMeta | null> {
    return this.meta ? structuredClone(this.meta) : null;
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    this.meta = structuredClone(meta);
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
  }
}
