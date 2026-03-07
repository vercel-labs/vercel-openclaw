import { randomUUID } from "node:crypto";

import {
  createDefaultMeta,
  ensureMetaShape,
  type SingleMeta,
} from "@/shared/types";
import { logInfo, logWarn } from "@/server/log";
import { MemoryStore } from "@/server/store/memory-store";
import { UpstashStore } from "@/server/store/upstash-store";

const INIT_LOCK_KEY = "openclaw-single:lock:init";

export type Store = {
  readonly name: string;
  getMeta(): Promise<SingleMeta | null>;
  setMeta(meta: SingleMeta): Promise<void>;
  getValue<T>(key: string): Promise<T | null>;
  setValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  deleteValue(key: string): Promise<void>;
  enqueue(key: string, value: string): Promise<number>;
  dequeue(key: string): Promise<string | null>;
  getQueueLength(key: string): Promise<number>;
  acquireLock(key: string, ttlSeconds: number): Promise<string | null>;
  releaseLock(key: string, token: string): Promise<void>;
};

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

let singletonStore: Store | null = null;

export function getStore(): Store {
  if (singletonStore) {
    return singletonStore;
  }

  const upstash = UpstashStore.fromEnv();
  if (upstash) {
    singletonStore = upstash;
    logInfo("store.initialized", { backend: singletonStore.name });
    return singletonStore;
  }

  if (isProductionRuntime()) {
    throw new Error(
      "Upstash Redis is required in production. " +
        "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, " +
        "or install the Upstash integration from the Vercel Marketplace.",
    );
  }

  logWarn("store.memory_fallback", {
    message: "Using in-memory store — data will not persist across restarts.",
  });
  singletonStore = new MemoryStore();
  logInfo("store.initialized", { backend: singletonStore.name });
  return singletonStore;
}

export async function getInitializedMeta(): Promise<SingleMeta> {
  const store = getStore();
  const existing = await store.getMeta();
  if (existing) {
    const hydrated = ensureMetaShape(existing);
    if (hydrated?.gatewayToken) {
      if (JSON.stringify(existing) !== JSON.stringify(hydrated)) {
        await store.setMeta(hydrated);
      }
      return hydrated;
    }
  }

  const initToken = await store.acquireLock(INIT_LOCK_KEY, 10);
  if (initToken) {
    try {
      const rechecked = await store.getMeta();
      const hydrated = ensureMetaShape(rechecked);
      if (hydrated?.gatewayToken) {
        return hydrated;
      }

      const created = createDefaultMeta(Date.now(), randomUUID());
      await store.setMeta(created);
      return created;
    } finally {
      await store.releaseLock(INIT_LOCK_KEY, initToken);
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await wait(50);
    const rechecked = await store.getMeta();
    const hydrated = ensureMetaShape(rechecked);
    if (hydrated?.gatewayToken) {
      return hydrated;
    }
  }

  const fallback = createDefaultMeta(Date.now(), randomUUID());
  await store.setMeta(fallback);
  return fallback;
}

export async function setMeta(next: SingleMeta): Promise<SingleMeta> {
  const store = getStore();
  const hydrated = ensureMetaShape(next);
  if (!hydrated?.gatewayToken) {
    throw new Error("Refusing to persist invalid meta state.");
  }

  hydrated.updatedAt = Date.now();
  await store.setMeta(hydrated);
  return hydrated;
}

export async function mutateMeta(
  mutator: (meta: SingleMeta) => SingleMeta | void,
): Promise<SingleMeta> {
  const current = await getInitializedMeta();
  const draft = structuredClone(current);
  const result = mutator(draft) ?? draft;
  return setMeta(result);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset singleton for testing only. */
export function _resetStoreForTesting(): void {
  singletonStore = null;
}
