import { randomBytes } from "node:crypto";

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
 */
export async function createSlackInstallToken(): Promise<string> {
  const token = randomBytes(INSTALL_TOKEN_BYTES).toString("base64url");
  const store = getStore();
  await store.setValue(
    slackInstallTokenKey(token),
    { issuedAt: Date.now() },
    INSTALL_TOKEN_TTL_SECONDS,
  );
  return token;
}

export async function consumeSlackInstallToken(token: string): Promise<boolean> {
  if (!token || token.length < 8) return false;
  const store = getStore();
  const key = slackInstallTokenKey(token);
  const record = await store.getValue<{ issuedAt?: number }>(key);
  if (!record) return false;
  await store.deleteValue(key);
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
  };
}
