import { randomBytes } from "node:crypto";

import { logInfo, logWarn } from "@/server/log";
import { slackAppConfigKey, slackInstallTokenKey } from "@/server/store/keyspace";
import { getStore } from "@/server/store/store";

/**
 * Credentials returned by `apps.manifest.create`, persisted so the OAuth
 * install flow and webhook signature verification can use them without
 * SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET env vars.
 *
 * `configToken` / `refreshToken` / `configTokenExpiresAt` enable future
 * `apps.manifest.update` calls without re-prompting the operator.
 */
export type StoredSlackAppConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  verificationToken?: string;
  configToken?: string;
  refreshToken?: string;
  /** Unix-epoch ms when the config token expires. */
  configTokenExpiresAt?: number;
  /** Unix-epoch ms. */
  createdAt: number;
  /** Display name echoed back to the admin panel. */
  appName?: string;
  /** Vercel scope/team slug that owned this app at create time. */
  projectScope?: string;
  /** Vercel project name that owned this app at create time. */
  projectName?: string;
};

/** Five-minute TTL matches the OAuth state cookie. */
const INSTALL_TOKEN_TTL_SECONDS = 5 * 60;
const INSTALL_TOKEN_BYTES = 24;

export async function getSlackAppConfig(): Promise<StoredSlackAppConfig | null> {
  const store = getStore();
  const raw = await store.getValue<unknown>(slackAppConfigKey());
  return normalizeAppConfig(raw);
}

export async function setSlackAppConfig(config: StoredSlackAppConfig): Promise<void> {
  const store = getStore();
  await store.setValue(slackAppConfigKey(), config);
}

export async function deleteSlackAppConfig(): Promise<void> {
  const store = getStore();
  await store.deleteValue(slackAppConfigKey());
}

/**
 * Mint a one-time token that grants permission to start the Slack OAuth
 * install flow without an admin session cookie. Burned on consume.
 *
 * Read-after-write: immediately fetches the key back and throws if Redis
 * silently dropped the SET. Without this, a transient store failure mints
 * a token the user will click, only to be rejected with
 * `slack_install_error=install_token_invalid` five seconds later — and the
 * token is already gone from memory, so the failure is unreproducible.
 */
export async function createSlackInstallToken(): Promise<string> {
  const token = randomBytes(INSTALL_TOKEN_BYTES).toString("base64url");
  const store = getStore();
  const key = slackInstallTokenKey(token);
  const tokenPrefix = token.slice(0, 6);

  await store.setValue(
    key,
    { issuedAt: Date.now() },
    INSTALL_TOKEN_TTL_SECONDS,
  );

  const persisted = await store.getValue<{ issuedAt?: number }>(key);
  if (!persisted || typeof persisted.issuedAt !== "number") {
    logWarn("slack_install_token.persistence_failed", {
      tokenPrefix,
      key,
      ttl: INSTALL_TOKEN_TTL_SECONDS,
      persistedType: persisted === null ? "null" : typeof persisted,
    });
    throw new Error(
      "Failed to persist Slack install token to Redis. " +
        "The SET succeeded but a read-after-write returned null — " +
        "check REDIS_URL / KV_URL and openclaw's store configuration.",
    );
  }

  logInfo("slack_install_token.created", {
    tokenPrefix,
    key,
    ttl: INSTALL_TOKEN_TTL_SECONDS,
    issuedAt: persisted.issuedAt,
  });

  return token;
}

export async function consumeSlackInstallToken(token: string): Promise<boolean> {
  if (!token || token.length < 8) {
    logWarn("slack_install_token.consume_miss", {
      reason: "token-too-short-or-missing",
      tokenLength: token?.length ?? 0,
    });
    return false;
  }
  const store = getStore();
  const key = slackInstallTokenKey(token);
  const tokenPrefix = token.slice(0, 6);
  const record = await store.getValue<{ issuedAt?: number }>(key);
  if (!record) {
    logWarn("slack_install_token.consume_miss", {
      reason: "not-found-in-store",
      tokenPrefix,
      key,
    });
    return false;
  }
  await store.deleteValue(key);
  logInfo("slack_install_token.consumed", {
    tokenPrefix,
    key,
    ageMs: record.issuedAt ? Date.now() - record.issuedAt : null,
  });
  return true;
}

function normalizeAppConfig(raw: unknown): StoredSlackAppConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Partial<StoredSlackAppConfig>;
  if (
    typeof r.appId !== "string" ||
    typeof r.clientId !== "string" ||
    typeof r.clientSecret !== "string" ||
    typeof r.signingSecret !== "string" ||
    typeof r.createdAt !== "number"
  ) {
    return null;
  }
  return {
    appId: r.appId,
    clientId: r.clientId,
    clientSecret: r.clientSecret,
    signingSecret: r.signingSecret,
    verificationToken:
      typeof r.verificationToken === "string" ? r.verificationToken : undefined,
    configToken: typeof r.configToken === "string" ? r.configToken : undefined,
    refreshToken: typeof r.refreshToken === "string" ? r.refreshToken : undefined,
    configTokenExpiresAt:
      typeof r.configTokenExpiresAt === "number" ? r.configTokenExpiresAt : undefined,
    createdAt: r.createdAt,
    appName: typeof r.appName === "string" ? r.appName : undefined,
    projectScope:
      typeof r.projectScope === "string" ? r.projectScope : undefined,
    projectName:
      typeof r.projectName === "string" ? r.projectName : undefined,
  };
}
