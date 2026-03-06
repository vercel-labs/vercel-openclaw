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
    const raw = await this.redis.get<string>(META_KEY);
    if (!raw) {
      return null;
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
