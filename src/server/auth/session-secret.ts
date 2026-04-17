import { randomBytes } from "node:crypto";

import { getAuthMode, isVercelDeployment } from "@/server/env";
import { logError, logInfo } from "@/server/log";
import { sessionSecretKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

const GENERATED_SESSION_SECRET_BYTES = 32;

export type ResolvedSessionSecret = {
  source: "env" | "generated";
  secret: string;
};

const generatedSessionSecretCache = new Map<string, string>();
const generatedSessionSecretLoadPromises = new Map<
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

async function loadOrCreateSessionSecret(
  secretKey: string,
): Promise<string | null> {
  try {
    const store = getStore();
    const existing = normalizeSecret(await store.getValue<string>(secretKey));
    if (existing) {
      generatedSessionSecretCache.set(secretKey, existing);
      return existing;
    }

    const generated = randomBytes(GENERATED_SESSION_SECRET_BYTES).toString(
      "hex",
    );
    await store.setValue(secretKey, generated);

    const persisted = normalizeSecret(await store.getValue<string>(secretKey));
    if (persisted) {
      generatedSessionSecretCache.set(secretKey, persisted);
      logInfo("auth.session_secret.generated", {
        bytes: GENERATED_SESSION_SECRET_BYTES,
      });
      return persisted;
    }

    logError("auth.session_secret.unavailable", {
      state: "missing_after_write",
    });
    return null;
  } catch (error) {
    logError("auth.session_secret.load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureGeneratedSessionSecretCache(): Promise<string | null> {
  const secretKey = sessionSecretKey();
  const cached = generatedSessionSecretCache.get(secretKey);
  if (cached) {
    return cached;
  }

  const existingLoadPromise = generatedSessionSecretLoadPromises.get(secretKey);
  if (existingLoadPromise) {
    return existingLoadPromise;
  }

  const loadPromise = loadOrCreateSessionSecret(secretKey).finally(() => {
    generatedSessionSecretLoadPromises.delete(secretKey);
  });
  generatedSessionSecretLoadPromises.set(secretKey, loadPromise);
  return loadPromise;
}

export async function resolveSessionSecretDetailed(): Promise<ResolvedSessionSecret> {
  const envSecret = normalizeSecret(process.env.SESSION_SECRET);
  if (envSecret) {
    return { source: "env", secret: envSecret };
  }

  if (getAuthMode() === "sign-in-with-vercel" && isVercelDeployment()) {
    throw new Error(
      "SESSION_SECRET is required for deployed sign-in-with-vercel mode.",
    );
  }

  const generated = await ensureGeneratedSessionSecretCache();
  if (!generated) {
    throw new Error(
      "Failed to auto-generate SESSION_SECRET (store unavailable).",
    );
  }
  return { source: "generated", secret: generated };
}

export async function resolveSessionSecret(): Promise<string> {
  const detailed = await resolveSessionSecretDetailed();
  return detailed.secret;
}

export function _resetSessionSecretCacheForTesting(): void {
  generatedSessionSecretCache.clear();
  generatedSessionSecretLoadPromises.clear();
}
