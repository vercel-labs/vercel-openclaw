import assert from "node:assert/strict";
import test from "node:test";

import { getStore, _resetStoreForTesting } from "@/server/store/store";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
  }
}

test("getStore: throws when Upstash missing and NODE_ENV=production", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      assert.throws(() => getStore(), /Upstash Redis is required in production/);
    },
  );
});

test("getStore: throws when Upstash missing and VERCEL=1", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: "1",
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      assert.throws(() => getStore(), /Upstash Redis is required in production/);
    },
  );
});

test("getStore: falls back to MemoryStore in development", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      const store = getStore();
      assert.equal(store.name, "memory");
    },
  );
});

test("getStore: falls back to MemoryStore when NODE_ENV is test", () => {
  withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    () => {
      const store = getStore();
      assert.equal(store.name, "memory");
    },
  );
});
