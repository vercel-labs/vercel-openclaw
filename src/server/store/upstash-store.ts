import { Redis } from "@upstash/redis";

import type { SingleMeta } from "@/shared/types";
import { getStoreEnv } from "@/server/env";

const META_KEY = "openclaw-single:meta";

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export class UpstashStore {
  readonly name = "upstash";

  constructor(private readonly redis: Redis) {}

  static fromEnv(): UpstashStore | null {
    const env = getStoreEnv();
    if (!env) {
      return null;
    }

    return new UpstashStore(
      new Redis({
        url: env.url,
        token: env.token,
      }),
    );
  }

  async getMeta(): Promise<SingleMeta | null> {
    const raw = await this.redis.get<SingleMeta | string>(META_KEY);
    if (!raw) {
      return null;
    }

    if (typeof raw === "object") {
      return raw as SingleMeta;
    }

    try {
      return JSON.parse(raw) as SingleMeta;
    } catch {
      return null;
    }
  }

  async setMeta(meta: SingleMeta): Promise<void> {
    await this.redis.set(META_KEY, JSON.stringify(meta));
  }

  async getValue<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }

    if (typeof raw === "object") {
      return raw as T;
    }

    try {
      return JSON.parse(raw as string) as T;
    } catch {
      return null;
    }
  }

  async setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (typeof ttlSeconds === "number") {
      await this.redis.set(key, payload, { ex: ttlSeconds });
      return;
    }

    await this.redis.set(key, payload);
  }

  async deleteValue(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async enqueue(key: string, value: string): Promise<number> {
    return this.redis.rpush(key, value);
  }

  async dequeue(key: string): Promise<string | null> {
    return this.redis.lpop<string>(key);
  }

  async getQueueLength(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const result = await this.redis.set(key, token, {
      nx: true,
      ex: ttlSeconds,
    });

    return result === "OK" ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_LUA, [key], [token]);
  }
}
