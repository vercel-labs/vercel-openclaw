import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetSessionSecretCacheForTesting,
  resolveSessionSecret,
  resolveSessionSecretDetailed,
} from "@/server/auth/session-secret";
import { _setInstanceIdOverrideForTesting } from "@/server/env";
import { _resetStoreForTesting } from "@/server/store/store";

type MutableEnv = Record<string, string | undefined>;

function snapshotEnv(keys: string[]): MutableEnv {
  const env = process.env as MutableEnv;
  const snapshot: MutableEnv = {};
  for (const key of keys) {
    snapshot[key] = env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: MutableEnv): void {
  const env = process.env as MutableEnv;
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

function resetAll(): void {
  _setInstanceIdOverrideForTesting(null);
  _resetStoreForTesting();
  _resetSessionSecretCacheForTesting();
}

const TRACKED_ENV_KEYS = [
  "SESSION_SECRET",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_AUTH_MODE",
  "NODE_ENV",
  "OPENCLAW_INSTANCE_ID",
];

test("resolveSessionSecret returns env var when set", async () => {
  const original = snapshotEnv(TRACKED_ENV_KEYS);
  const env = process.env as MutableEnv;

  env.SESSION_SECRET = "explicit-session-secret-value";
  env.NODE_ENV = "test";
  delete env.VERCEL_AUTH_MODE;
  resetAll();

  try {
    const detailed = await resolveSessionSecretDetailed();
    assert.equal(detailed.source, "env");
    assert.equal(detailed.secret, "explicit-session-secret-value");
  } finally {
    restoreEnv(original);
    resetAll();
  }
});

test("resolveSessionSecret auto-generates and persists through the store, scoped by instance id", async () => {
  const original = snapshotEnv(TRACKED_ENV_KEYS);
  const env = process.env as MutableEnv;

  delete env.SESSION_SECRET;
  delete env.VERCEL_AUTH_MODE;
  env.NODE_ENV = "test";
  delete env.OPENCLAW_INSTANCE_ID;
  resetAll();

  try {
    _setInstanceIdOverrideForTesting("fork-a");

    const first = await resolveSessionSecretDetailed();
    assert.equal(first.source, "generated");
    assert.ok(first.secret);
    assert.notEqual(first.secret, "openclaw-single-local-session-secret-change-me");

    const second = await resolveSessionSecretDetailed();
    assert.equal(second.source, "generated");
    assert.equal(
      second.secret,
      first.secret,
      "same instance should return the persisted secret on subsequent calls",
    );

    _setInstanceIdOverrideForTesting("fork-b");
    const other = await resolveSessionSecretDetailed();
    assert.equal(other.source, "generated");
    assert.notEqual(
      other.secret,
      first.secret,
      "different instance ids must not share a generated session secret",
    );
  } finally {
    restoreEnv(original);
    resetAll();
  }
});

test("resolveSessionSecret throws for deployed sign-in-with-vercel mode without env var", async () => {
  const original = snapshotEnv(TRACKED_ENV_KEYS);
  const env = process.env as MutableEnv;

  delete env.SESSION_SECRET;
  env.VERCEL = "1";
  env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  env.NODE_ENV = "test";
  resetAll();

  try {
    await assert.rejects(
      () => resolveSessionSecret(),
      /SESSION_SECRET is required for deployed sign-in-with-vercel mode/,
    );
  } finally {
    restoreEnv(original);
    resetAll();
  }
});
