import { randomUUID } from "node:crypto";

import {
  createDefaultMeta,
  ensureMetaShape,
  type SingleMeta,
} from "@/shared/types";
import {
  DEFAULT_OPENCLAW_INSTANCE_ID,
  getOpenclawInstanceId,
  isVercelDeployment,
  requiresDurableStore,
} from "@/server/env";
import { logInfo, logWarn } from "@/server/log";
import { initLockKey } from "@/server/store/keyspace";
import { MemoryStore } from "@/server/store/memory-store";
import { RedisStore } from "@/server/store/redis-store";

const INIT_LOCK_TTL_SECONDS = 10;
const INIT_READ_RETRY_COUNT = 20;
const INIT_READ_RETRY_DELAY_MS = 50;
const META_CAS_MAX_RETRIES = 10;
const META_CAS_RETRY_DELAY_MS = 25;

export type Store = {
  readonly name: string;
  getMeta(): Promise<SingleMeta | null>;
  setMeta(meta: SingleMeta): Promise<void>;
  createMetaIfAbsent(meta: SingleMeta): Promise<boolean>;
  compareAndSetMeta(expectedVersion: number, next: SingleMeta): Promise<boolean>;
  getValue<T>(key: string): Promise<T | null>;
  setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
  acquireLock(key: string, ttlSeconds: number): Promise<string | null>;
  renewLock(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
};

let singletonStore: Store | null = null;

export function getStore(): Store {
  if (singletonStore) {
    return singletonStore;
  }

  // Only deployed Vercel runtimes may use Redis. Tests and local/CI paths
  // must stay on memory store even when Redis env vars leak in.
  if (process.env.NODE_ENV === "test") {
    logWarn("store.memory_fallback", {
      message: "Using in-memory store — data will not persist across restarts.",
    });
    singletonStore = new MemoryStore();
    logInfo("store.initialized", { backend: singletonStore.name });
    return singletonStore;
  }

  if (isVercelDeployment()) {
    const redis = RedisStore.fromEnv();
    if (redis) {
      singletonStore = redis;
      if (getOpenclawInstanceId() === DEFAULT_OPENCLAW_INSTANCE_ID) {
        logWarn("store.default_instance_id", {
          backend: singletonStore.name,
          instanceId: DEFAULT_OPENCLAW_INSTANCE_ID,
          message:
            "Using default OPENCLAW_INSTANCE_ID. Shared Redis deployments should set a unique instance id.",
        });
      }
      logInfo("store.initialized", { backend: singletonStore.name });
      return singletonStore;
    }
  }

  if (requiresDurableStore()) {
    throw new Error(
      "Redis is required on Vercel deployments. " +
        "Set REDIS_URL, or install a Redis integration from the Vercel Marketplace.",
    );
  }

  logWarn("store.memory_fallback", {
    message: "Using in-memory store — data will not persist across restarts.",
  });
  singletonStore = new MemoryStore();
  logInfo("store.initialized", { backend: singletonStore.name });
  return singletonStore;
}

function validateMetaOrThrow(input: unknown): SingleMeta {
  const hydrated = ensureMetaShape(input, getOpenclawInstanceId());
  if (!hydrated?.gatewayToken) {
    throw new Error("Refusing to use invalid meta state.");
  }

  return hydrated;
}

async function readPersistedMetaOrThrow(): Promise<SingleMeta | null> {
  const existing = await getStore().getMeta();
  if (existing === null) {
    return null;
  }

  return validateMetaOrThrow(existing);
}

export async function getInitializedMeta(): Promise<SingleMeta> {
  const existing = await readPersistedMetaOrThrow();
  if (existing) {
    return existing;
  }

  const store = getStore();
  const initKey = initLockKey();
  const initToken = await store.acquireLock(initKey, INIT_LOCK_TTL_SECONDS);
  if (initToken) {
    try {
      const rechecked = await readPersistedMetaOrThrow();
      if (rechecked) {
        return rechecked;
      }

      const created = createDefaultMeta(
        Date.now(),
        randomUUID(),
        getOpenclawInstanceId(),
      );
      const initialized = await store.createMetaIfAbsent(created);
      if (initialized) {
        return created;
      }

      const afterRace = await readPersistedMetaOrThrow();
      if (afterRace) {
        return afterRace;
      }

      throw new Error("Meta state exists but could not be loaded safely.");
    } finally {
      await store.releaseLock(initKey, initToken);
    }
  }

  for (let attempt = 0; attempt < INIT_READ_RETRY_COUNT; attempt += 1) {
    await wait(INIT_READ_RETRY_DELAY_MS);
    const rechecked = await readPersistedMetaOrThrow();
    if (rechecked) {
      return rechecked;
    }
  }

  throw new Error("Meta initialization failed or is still in progress.");
}

export async function setMeta(next: SingleMeta): Promise<SingleMeta> {
  const hydrated = validateMetaOrThrow(next);
  return mutateMeta(() => hydrated);
}

export async function mutateMeta(
  mutator: (meta: SingleMeta) => SingleMeta | void,
): Promise<SingleMeta> {
  const store = getStore();
  let lastConflict: Error | null = null;

  for (let attempt = 0; attempt < META_CAS_MAX_RETRIES; attempt += 1) {
    const current = await getInitializedMeta();
    const draft = structuredClone(current);
    const mutated = mutator(draft) ?? draft;
    const next = validateMetaOrThrow(mutated);
    next.version = current.version + 1;
    next.updatedAt = Date.now();

    const saved = await store.compareAndSetMeta(current.version, next);
    if (saved) {
      return next;
    }

    lastConflict = new Error(
      `Meta write conflict detected (attempt ${attempt + 1}/${META_CAS_MAX_RETRIES}).`,
    );

    if (attempt < META_CAS_MAX_RETRIES - 1) {
      await wait(META_CAS_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw (
    lastConflict ??
    new Error("Failed to mutate meta after repeated concurrent write conflicts.")
  );
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function _resetStoreForTesting(): void {
  singletonStore = null;
}
