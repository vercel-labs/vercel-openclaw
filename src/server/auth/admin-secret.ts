import { randomBytes } from "node:crypto";

import { logInfo, logError } from "@/server/log";
import { adminSecretKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const GENERATED_ADMIN_SECRET_BYTES = 32;

export type ConfiguredAdminSecret = {
  source: "env" | "generated";
  secret: string;
};

const generatedAdminSecretCache = new Map<string, string>();
const generatedAdminSecretLoadPromises = new Map<
  string,
  Promise<string | null>
>();

function normalizeSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function loadOrCreateAdminSecret(secretKey: string): Promise<string | null> {
  try {
    const store = getStore();
    const existing = normalizeSecret(await store.getValue<string>(secretKey));
    if (existing) {
      generatedAdminSecretCache.set(secretKey, existing);
      return existing;
    }

    const generated = randomBytes(GENERATED_ADMIN_SECRET_BYTES).toString("hex");
    // Use setValue — the store handles persistence. For Redis this is
    // idempotent across concurrent cold-starts because the first writer wins
    // and subsequent reads return the persisted value.
    await store.setValue(secretKey, generated);

    // Verify it was actually written (handles race conditions)
    const persisted = normalizeSecret(await store.getValue<string>(secretKey));
    if (persisted) {
      generatedAdminSecretCache.set(secretKey, persisted);
      logInfo("auth.admin_secret.generated", {
        bytes: GENERATED_ADMIN_SECRET_BYTES,
      });
      return persisted;
    }

    logError("auth.admin_secret.unavailable", {
      state: "missing_after_write",
    });
    return null;
  } catch (error) {
    logError("auth.admin_secret.load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureGeneratedAdminSecretCache(): Promise<string | null> {
  const secretKey = adminSecretKey();
  const cachedSecret = generatedAdminSecretCache.get(secretKey);
  if (cachedSecret) {
    return cachedSecret;
  }

  const existingLoadPromise = generatedAdminSecretLoadPromises.get(secretKey);
  if (existingLoadPromise) {
    return existingLoadPromise;
  }

  const loadPromise = loadOrCreateAdminSecret(secretKey).finally(() => {
    generatedAdminSecretLoadPromises.delete(secretKey);
  });
  generatedAdminSecretLoadPromises.set(secretKey, loadPromise);
  return loadPromise;
}

export async function getConfiguredAdminSecret(): Promise<ConfiguredAdminSecret | null> {
  const envSecret = normalizeSecret(process.env.ADMIN_SECRET);
  if (envSecret) {
    return { source: "env", secret: envSecret };
  }

  const generated = await ensureGeneratedAdminSecretCache();
  if (!generated) {
    return null;
  }

  return { source: "generated", secret: generated };
}

export function _resetAdminSecretCacheForTesting(): void {
  generatedAdminSecretCache.clear();
  generatedAdminSecretLoadPromises.clear();
}
