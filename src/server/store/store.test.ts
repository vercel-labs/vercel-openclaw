import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultMeta,
  ensureMetaShape,
  CURRENT_SCHEMA_VERSION,
} from "@/shared/types";
import {
  _setInstanceIdOverrideForTesting,
  getOpenclawInstanceId,
} from "@/server/env";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { initLockKey, metaKey } from "@/server/store/keyspace";
import {
  getInitializedMeta,
  getStore,
  setMeta,
  mutateMeta,
  _resetStoreForTesting,
} from "@/server/store/store";
import { RedisStore } from "@/server/store/redis-store";

type EvalHandler = (keys: string[], args: string[]) => unknown;

class FakeRedis {
  readonly values = new Map<string, string>();

  evalHandler: EvalHandler | null = null;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    // ioredis set supports positional modifiers: "NX" / "XX", "EX" <n>, "PX" <n>, "KEEPTTL"
    let nxOnly = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === "NX") nxOnly = true;
      if (token === "EX" || token === "PX") {
        i += 1; // skip TTL value
      }
    }

    if (nxOnly && this.values.has(key)) {
      return null;
    }

    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(
    _script: string,
    numKeys: number,
    ...rest: string[]
  ): Promise<unknown> {
    if (!this.evalHandler) {
      throw new Error("Missing eval handler");
    }
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    return this.evalHandler(keys, args);
  }
}

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  const restore = () => {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _setInstanceIdOverrideForTesting(null);
    _resetLogBuffer();
    _resetStoreForTesting();
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

test("getStore: allows memory store when NODE_ENV=production without Vercel markers", () => {
  withEnv(
    {
      NODE_ENV: "production",
      VERCEL: undefined,
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
    },
    () => {
      assert.equal(getStore().name, "memory");
    },
  );
});

test("getStore: throws when Redis missing and VERCEL=1", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: "1",
      VERCEL_ENV: undefined,
      VERCEL_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
    },
    () => {
      assert.throws(
        () => getStore(),
        /Redis is required on Vercel deployments/,
      );
    },
  );
});

test("getStore: falls back to MemoryStore in development", () => {
  withEnv(
    {
      NODE_ENV: "development",
      VERCEL: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
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
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
    },
    () => {
      const store = getStore();
      assert.equal(store.name, "memory");
    },
  );
});

test("getStore: compareAndSetMeta rejects stale versions and accepts current", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
    },
    async () => {
      const store = getStore();
      const meta = createDefaultMeta(Date.now(), "gateway-token");
      const created = await store.createMetaIfAbsent(meta);

      assert.equal(created, true);

      const staleWrite = await store.compareAndSetMeta(99, {
        ...meta,
        version: 100,
      });
      assert.equal(staleWrite, false);

      const currentWrite = await store.compareAndSetMeta(1, {
        ...meta,
        version: 2,
        status: "creating",
      });
      assert.equal(currentWrite, true);

      const persisted = await store.getMeta();
      assert.equal(persisted?.version, 2);
      assert.equal(persisted?.status, "creating");
    },
  );
});

test("mutateMeta: increments persisted version after initialization", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      REDIS_URL: undefined,
      KV_URL: undefined,
      OPENCLAW_INSTANCE_ID: undefined,
    },
    async () => {
      const initial = await getInitializedMeta();
      assert.equal(initial.version, 1);

      const updated = await mutateMeta((meta) => {
        meta.status = "creating";
      });

      assert.equal(updated.version, 2);
      assert.equal(updated.status, "creating");

      const persisted = await getStore().getMeta();
      assert.equal(persisted?.version, 2);
      assert.equal(persisted?.status, "creating");
    },
  );
});

// ---------------------------------------------------------------------------
// ensureMetaShape migration tests
// ---------------------------------------------------------------------------

test("ensureMetaShape: fills missing channels with empty channel configs", () => {
  const input = {
    gatewayToken: "tok-1",
    status: "running",
    version: 3,
    createdAt: 1000,
    updatedAt: 2000,
    // channels field is absent
  };

  const result = ensureMetaShape(input);
  assert.ok(result);
  assert.deepStrictEqual(result.channels, {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  });
});

test("ensureMetaShape: fills missing snapshotHistory with empty array", () => {
  const input = {
    gatewayToken: "tok-2",
    status: "stopped",
    version: 1,
    createdAt: 1000,
    // snapshotHistory field is absent
  };

  const result = ensureMetaShape(input);
  assert.ok(result);
  assert.deepStrictEqual(result.snapshotHistory, []);
});

test("ensureMetaShape: fills missing firewall with default disabled state", () => {
  const input = {
    gatewayToken: "tok-3",
    status: "uninitialized",
    version: 1,
    createdAt: 1000,
    // firewall field is absent
  };

  const result = ensureMetaShape(input);
  assert.ok(result);
  assert.equal(result.firewall.mode, "disabled");
  assert.deepStrictEqual(result.firewall.allowlist, []);
  assert.deepStrictEqual(result.firewall.learned, []);
  assert.deepStrictEqual(result.firewall.events, []);
  assert.equal(result.firewall.lastIngestedAt, null);
});

test("ensureMetaShape: preserves existing fields when all present", () => {
  const now = Date.now();
  const full = createDefaultMeta(now, "full-token");
  full.status = "running";
  full.sandboxId = "sbx-123";
  full.snapshotId = "snap-456";
  full.version = 5;
  full.firewall.mode = "enforcing";
  full.firewall.allowlist = ["example.com"];
  full.snapshotHistory = [
    { id: "rec-1", snapshotId: "snap-456", timestamp: now, reason: "manual" },
  ];

  const result = ensureMetaShape(full);
  assert.ok(result);
  assert.equal(result.status, "running");
  assert.equal(result.sandboxId, "sbx-123");
  assert.equal(result.snapshotId, "snap-456");
  assert.equal(result.version, 5);
  assert.equal(result.gatewayToken, "full-token");
  assert.equal(result.firewall.mode, "enforcing");
  assert.deepStrictEqual(result.firewall.allowlist, ["example.com"]);
  assert.equal(result.snapshotHistory.length, 1);
  assert.equal(result.snapshotHistory[0].snapshotId, "snap-456");
  assert.deepStrictEqual(result.channels, {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  });
});

test("ensureMetaShape: handles completely empty object (worst-case legacy data)", () => {
  const result = ensureMetaShape({});
  // Empty object has no gatewayToken, so it gets "" which is falsy
  // validateMetaOrThrow would reject this, but ensureMetaShape itself returns it
  assert.ok(result);
  assert.equal(result._schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.id, "openclaw-single");
  assert.equal(result.version, 1);
  assert.equal(result.status, "uninitialized");
  assert.equal(result.gatewayToken, "");
  assert.equal(result.sandboxId, null);
  assert.equal(result.snapshotId, null);
  assert.equal(result.firewall.mode, "disabled");
  assert.deepStrictEqual(result.firewall.allowlist, []);
  assert.deepStrictEqual(result.firewall.learned, []);
  assert.deepStrictEqual(result.firewall.events, []);
  assert.deepStrictEqual(result.channels, {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  });
  assert.deepStrictEqual(result.snapshotHistory, []);
});

test("ensureMetaShape: fills missing id with current instance id", () => {
  try {
    _setInstanceIdOverrideForTesting("fork-shape");
    const result = ensureMetaShape({ gatewayToken: "tok-shape" });
    assert.ok(result);
    assert.equal(result.id, "fork-shape");
  } finally {
    _setInstanceIdOverrideForTesting(null);
  }
});

test("ensureMetaShape: rejects mismatched ids", () => {
  assert.throws(
    () => ensureMetaShape({ id: "fork-a", gatewayToken: "tok-mismatch" }, "fork-b"),
    /Refusing to hydrate meta for instance "fork-a" while expecting "fork-b"/,
  );
});

test("ensureMetaShape: returns null for non-object inputs", () => {
  assert.equal(ensureMetaShape(null), null);
  assert.equal(ensureMetaShape(undefined), null);
  assert.equal(ensureMetaShape("string"), null);
  assert.equal(ensureMetaShape(42), null);
  assert.equal(ensureMetaShape([1, 2, 3]), null);
});

test("ensureMetaShape: filters invalid learned domains and firewall events", () => {
  const input = {
    gatewayToken: "tok-4",
    firewall: {
      mode: "learning",
      allowlist: ["good.com", 123, null],
      learned: [
        { domain: "valid.com", firstSeenAt: 1, lastSeenAt: 2, hitCount: 3 },
        { domain: "bad" }, // missing fields
        "not-an-object",
      ],
      events: [
        { id: "e1", timestamp: 1, action: "allow", decision: "pass" },
        { id: "e2" }, // missing fields
      ],
    },
  };

  const result = ensureMetaShape(input);
  assert.ok(result);
  assert.equal(result.firewall.mode, "learning");
  assert.deepStrictEqual(result.firewall.allowlist, ["good.com"]);
  assert.equal(result.firewall.learned.length, 1);
  assert.equal(result.firewall.learned[0].domain, "valid.com");
  assert.equal(result.firewall.events.length, 1);
  assert.equal(result.firewall.events[0].id, "e1");
});

test("ensureMetaShape: filters invalid snapshot records", () => {
  const input = {
    gatewayToken: "tok-5",
    snapshotHistory: [
      { id: "r1", snapshotId: "s1", timestamp: 100, reason: "auto" },
      { id: "r2" }, // missing fields
      null,
      "not-a-record",
      { id: "r3", snapshotId: "s3", timestamp: 300, reason: "manual" },
    ],
  };

  const result = ensureMetaShape(input);
  assert.ok(result);
  assert.equal(result.snapshotHistory.length, 2);
  assert.equal(result.snapshotHistory[0].id, "r1");
  assert.equal(result.snapshotHistory[1].id, "r3");
});

test("ensureMetaShape: coerces invalid version to 1", () => {
  const result = ensureMetaShape({ gatewayToken: "tok-6", version: -5 });
  assert.ok(result);
  assert.equal(result.version, 1);

  const result2 = ensureMetaShape({ gatewayToken: "tok-7", version: 1.5 });
  assert.ok(result2);
  assert.equal(result2.version, 1); // not safe integer

  const result3 = ensureMetaShape({ gatewayToken: "tok-8", version: "bad" });
  assert.ok(result3);
  assert.equal(result3.version, 1);
});

test("ensureMetaShape: coerces invalid status to uninitialized", () => {
  const result = ensureMetaShape({
    gatewayToken: "tok-9",
    status: "bogus-status",
  });
  assert.ok(result);
  assert.equal(result.status, "uninitialized");
});

test("ensureMetaShape: coerces invalid firewall mode to disabled", () => {
  const result = ensureMetaShape({
    gatewayToken: "tok-10",
    firewall: { mode: "turbo" },
  });
  assert.ok(result);
  assert.equal(result.firewall.mode, "disabled");
});

// ---------------------------------------------------------------------------
// ensureMetaShape: produces clean default for deeply corrupted input
// ---------------------------------------------------------------------------

test("ensureMetaShape: produces clean default for deeply corrupted input", () => {
  // Simulate maximally corrupted data — every field has the wrong type
  const corrupted = {
    gatewayToken: 12345,
    status: { not: "a string" },
    version: "not-a-number",
    sandboxId: [],
    snapshotId: true,
    firewall: "not-an-object",
    channels: "not-an-object",
    snapshotHistory: "not-an-array",
    createdAt: "not-a-number",
    updatedAt: null,
  };

  const result = ensureMetaShape(corrupted);
  assert.ok(result);

  // Should produce safe defaults for all fields
  assert.equal(result._schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.id, "openclaw-single");
  assert.equal(result.status, "uninitialized");
  assert.equal(result.version, 1);
  assert.equal(result.firewall.mode, "disabled");
  assert.deepStrictEqual(result.firewall.allowlist, []);
  assert.deepStrictEqual(result.firewall.learned, []);
  assert.deepStrictEqual(result.firewall.events, []);
  assert.deepStrictEqual(result.channels, {
    slack: null,
    telegram: null,
    discord: null,
    whatsapp: null,
  });
  assert.deepStrictEqual(result.snapshotHistory, []);
});

// ---------------------------------------------------------------------------
// Edge-branch: setMeta round-trip
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
  OPENCLAW_INSTANCE_ID: undefined,
};

test("[store] setMeta round-trip -> persists and reads back identical meta", async () => {
  await withEnv(TEST_ENV, async () => {
    const initial = await getInitializedMeta();

    const modified = structuredClone(initial);
    modified.status = "running";
    modified.sandboxId = "sbx-round-trip";

    const result = await setMeta(modified);
    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, "sbx-round-trip");
    assert.ok(result.version > initial.version);

    const persisted = await getInitializedMeta();
    assert.equal(persisted.status, "running");
    assert.equal(persisted.sandboxId, "sbx-round-trip");
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: setMeta rejects invalid meta (missing gatewayToken)
// ---------------------------------------------------------------------------

test("[store] setMeta with empty gatewayToken -> throws validation error", async () => {
  await withEnv(TEST_ENV, async () => {
    await getInitializedMeta(); // ensure initialized

    const bad = createDefaultMeta(Date.now(), "");
    await assert.rejects(
      () => setMeta(bad),
      /Refusing to use invalid meta state/,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: singleton caching and reset
// ---------------------------------------------------------------------------

test("[store] getStore returns same instance (singleton caching)", () => {
  withEnv(TEST_ENV, () => {
    const store1 = getStore();
    const store2 = getStore();
    assert.equal(store1, store2);
  });
});

test("[store] _resetStoreForTesting clears singleton", () => {
  withEnv(TEST_ENV, () => {
    const store1 = getStore();
    _resetStoreForTesting();
    // After reset, need new env setup to get store
    withEnv(TEST_ENV, () => {
      const store2 = getStore();
      assert.notEqual(store1, store2);
    });
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: init lock contention -> retry success
// ---------------------------------------------------------------------------

test("[store] getInitializedMeta lock contention -> retries and reads meta from other writer", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();

    // Pre-populate meta as if another process wrote it
    const meta = createDefaultMeta(Date.now(), "pre-written-token");
    await store.setMeta(meta);

    // Now lock the init key so getInitializedMeta can't acquire it
    const lockToken = await store.acquireLock(initLockKey(), 60);
    assert.ok(lockToken);

    // getInitializedMeta should find existing meta on first read (before lock)
    const result = await getInitializedMeta();
    assert.equal(result.gatewayToken, "pre-written-token");

    await store.releaseLock(initLockKey(), lockToken);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: init lock contention -> retry loop finds meta eventually
// ---------------------------------------------------------------------------

test("[store] getInitializedMeta lock miss with no meta -> retries until meta appears", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();

    // Acquire the init lock to force the retry loop
    const lockToken = await store.acquireLock(initLockKey(), 60);
    assert.ok(lockToken);

    // After a short delay, write meta and release the lock
    const writeDelay = setTimeout(async () => {
      const meta = createDefaultMeta(Date.now(), "delayed-token");
      await store.setMeta(meta);
      await store.releaseLock(initLockKey(), lockToken);
    }, 100);

    try {
      const result = await getInitializedMeta();
      assert.equal(result.gatewayToken, "delayed-token");
    } finally {
      clearTimeout(writeDelay);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: CAS retry on concurrent conflict
// ---------------------------------------------------------------------------

test("[store] mutateMeta CAS conflict -> retries and succeeds", async () => {
  await withEnv(TEST_ENV, async () => {
    const initial = await getInitializedMeta();
    assert.equal(initial.version, 1);

    // Simulate a concurrent writer bumping version
    const store = getStore();
    const concurrent = structuredClone(initial);
    concurrent.version = 2;
    concurrent.status = "creating";
    await store.setMeta(concurrent);

    // mutateMeta should detect the conflict, re-read, and succeed
    const result = await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-cas-retry";
    });

    assert.equal(result.status, "running");
    assert.equal(result.sandboxId, "sbx-cas-retry");
    assert.ok(result.version > 2, `Version should be > 2, got ${result.version}`);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: createMetaIfAbsent returns false when meta already exists
// ---------------------------------------------------------------------------

test("[store] createMetaIfAbsent returns false when meta exists", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();
    const meta1 = createDefaultMeta(Date.now(), "first-token");
    const created = await store.createMetaIfAbsent(meta1);
    assert.equal(created, true);

    const meta2 = createDefaultMeta(Date.now(), "second-token");
    const duplicate = await store.createMetaIfAbsent(meta2);
    assert.equal(duplicate, false);

    // Original should be preserved
    const persisted = await store.getMeta();
    assert.equal(persisted?.gatewayToken, "first-token");
  });
});

// ===========================================================================
// Store contract tests: getValue / setValue / deleteValue round-trip
// ===========================================================================

test("[store] getValue/setValue/deleteValue round-trip", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();

    // Initially null
    const missing = await store.getValue<string>("test-key");
    assert.equal(missing, null);

    // Set and read back
    await store.setValue("test-key", { hello: "world" });
    const found = await store.getValue<{ hello: string }>("test-key");
    assert.deepStrictEqual(found, { hello: "world" });

    // Overwrite
    await store.setValue("test-key", { hello: "updated" });
    const updated = await store.getValue<{ hello: string }>("test-key");
    assert.deepStrictEqual(updated, { hello: "updated" });

    // Delete
    await store.deleteValue("test-key");
    const deleted = await store.getValue<string>("test-key");
    assert.equal(deleted, null);
  });
});

test("[store] setValue with TTL expires values", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();

    // Set with a very short TTL (0 seconds = immediate expiry on next gc)
    await store.setValue("ttl-key", "ephemeral", 0);

    // Wait briefly so gc picks it up
    await new Promise((r) => setTimeout(r, 10));

    const result = await store.getValue<string>("ttl-key");
    assert.equal(result, null, "Value should have expired");
  });
});

// ===========================================================================
// Store contract tests: lock operations
// ===========================================================================

test("[store] acquireLock / renewLock / releaseLock", async () => {
  await withEnv(TEST_ENV, async () => {
    const store = getStore();
    const lockKey = "test-lock";

    const token = await store.acquireLock(lockKey, 60);
    assert.ok(token, "Should acquire lock");

    // Cannot acquire again while held
    const second = await store.acquireLock(lockKey, 60);
    assert.equal(second, null, "Cannot double-acquire");

    // Renew succeeds with correct token
    const renewed = await store.renewLock(lockKey, token!, 60);
    assert.equal(renewed, true);

    // Renew fails with wrong token
    const badRenew = await store.renewLock(lockKey, "wrong-token", 60);
    assert.equal(badRenew, false);

    // Release
    await store.releaseLock(lockKey, token!);

    // Can acquire again after release
    const reacquired = await store.acquireLock(lockKey, 60);
    assert.ok(reacquired, "Should reacquire after release");
    await store.releaseLock(lockKey, reacquired!);
  });
});

// ===========================================================================
// createDefaultMeta produces valid defaults for all required fields
// ===========================================================================

test("[types] createDefaultMeta produces valid defaults for all required fields", () => {
  const now = Date.now();
  const meta = createDefaultMeta(now, "test-gw-token");

  // Identity
  assert.equal(meta._schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(meta.id, "openclaw-single");
  assert.equal(meta.version, 1);

  // Status
  assert.equal(meta.status, "uninitialized");
  assert.equal(meta.gatewayToken, "test-gw-token");

  // Timestamps
  assert.equal(meta.createdAt, now);
  assert.equal(meta.updatedAt, now);
  assert.equal(meta.lastAccessedAt, null);
  assert.equal(meta.lastTokenRefreshAt, null);

  // Nullable refs
  assert.equal(meta.sandboxId, null);
  assert.equal(meta.snapshotId, null);
  assert.equal(meta.portUrls, null);
  assert.equal(meta.startupScript, null);
  assert.equal(meta.lastError, null);

  // Firewall defaults
  assert.equal(meta.firewall.mode, "disabled");
  assert.deepStrictEqual(meta.firewall.allowlist, ["ai-gateway.vercel.sh"]);
  assert.deepStrictEqual(meta.firewall.learned, []);
  assert.deepStrictEqual(meta.firewall.events, []);
  assert.equal(meta.firewall.updatedAt, now);
  assert.equal(meta.firewall.lastIngestedAt, null);

  // Channel defaults
  assert.equal(meta.channels.slack, null);
  assert.equal(meta.channels.telegram, null);
  assert.equal(meta.channels.discord, null);

  // Snapshot history
  assert.deepStrictEqual(meta.snapshotHistory, []);

  // Round-trip through ensureMetaShape should be identity
  const roundTripped = ensureMetaShape(meta);
  assert.ok(roundTripped);
  assert.equal(roundTripped.gatewayToken, "test-gw-token");
  assert.equal(roundTripped.status, "uninitialized");
  assert.equal(roundTripped._schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("[types] createDefaultMeta uses current instance id by default", () => {
  try {
    _setInstanceIdOverrideForTesting("fork-meta");
    const meta = createDefaultMeta(Date.now(), "fork-token");
    assert.equal(meta.id, "fork-meta");
  } finally {
    _setInstanceIdOverrideForTesting(null);
  }
});

test("[store] keyspace default matches legacy hardcoded keys byte-for-byte", () => {
  _setInstanceIdOverrideForTesting(null);
  assert.equal(getOpenclawInstanceId(), "openclaw-single");
  assert.equal(metaKey(), "openclaw-single:meta");
  assert.equal(initLockKey(), "openclaw-single:lock:init");
});

test("[store] custom instance id isolates initialized meta and lock keyspace", async () => {
  await withEnv(
    {
      ...TEST_ENV,
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const first = await getInitializedMeta();
      assert.equal(first.id, "fork-a");

      const defaultMetaKey = metaKey();
      const defaultInitLockKey = initLockKey();
      assert.equal(defaultMetaKey, "fork-a:meta");
      assert.equal(defaultInitLockKey, "fork-a:lock:init");

      _setInstanceIdOverrideForTesting("fork-b");
      const store = getStore();
      assert.equal(await store.getMeta(), null);

      const second = await getInitializedMeta();
      assert.equal(second.id, "fork-b");
      assert.notDeepEqual(second.gatewayToken, first.gatewayToken);

      _setInstanceIdOverrideForTesting("fork-a");
      const restored = await getInitializedMeta();
      assert.equal(restored.id, "fork-a");
      assert.equal(restored.gatewayToken, first.gatewayToken);
    },
  );
});

test("[store] blank OPENCLAW_INSTANCE_ID throws instead of falling back", () => {
  withEnv(
    {
      ...TEST_ENV,
      OPENCLAW_INSTANCE_ID: "   ",
    },
    () => {
      assert.throws(() => getOpenclawInstanceId(), /OPENCLAW_INSTANCE_ID must not be blank/);
      assert.throws(() => metaKey(), /OPENCLAW_INSTANCE_ID must not be blank/);
      assert.throws(() => ensureMetaShape({ gatewayToken: "tok-blank" }), /OPENCLAW_INSTANCE_ID must not be blank/);
    },
  );
});

test("[store] OPENCLAW_INSTANCE_ID rejects embedded separators", () => {
  withEnv(
    {
      ...TEST_ENV,
      OPENCLAW_INSTANCE_ID: "fork-a:meta",
    },
    () => {
      assert.throws(() => getOpenclawInstanceId(), /OPENCLAW_INSTANCE_ID must not contain ':'/);
      assert.throws(() => metaKey(), /OPENCLAW_INSTANCE_ID must not contain ':'/);
      assert.throws(() => createDefaultMeta(Date.now(), "tok-bad"), /OPENCLAW_INSTANCE_ID must not contain ':'/);
    },
  );
});

// ===========================================================================
// Concurrent metadata mutations are serializable
// ===========================================================================

test("[store] concurrent mutateMeta calls are serializable", async () => {
  await withEnv(TEST_ENV, async () => {
    const initial = await getInitializedMeta();
    assert.equal(initial.version, 1);

    // Fire 5 concurrent mutations — each increments lastAccessedAt
    const mutations = Array.from({ length: 5 }, (_, i) =>
      mutateMeta((meta) => {
        meta.lastAccessedAt = (meta.lastAccessedAt ?? 0) + 1;
        meta.lastError = `mutation-${i}`;
      }),
    );

    const results = await Promise.all(mutations);

    // All should have succeeded (unique versions)
    const versions = results.map((r) => r.version);
    const uniqueVersions = new Set(versions);
    assert.equal(uniqueVersions.size, 5, "All 5 mutations should get unique versions");

    // Final persisted state should reflect all 5 increments
    const final = await getInitializedMeta();
    assert.equal(final.lastAccessedAt, 5, "All 5 increments should have applied");
    assert.equal(final.version, 6, "Version should be initial(1) + 5 mutations = 6");
  });
});

test("[redis-store] low-level redis methods reject unscoped keys", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const redis = new FakeRedis();
      const store = new RedisStore(redis as never);

      await assert.rejects(() => store.getValue("fork-b:key"), /outside instance prefix "fork-a:"/);
      await assert.rejects(() => store.setValue("plain-key", "value"), /outside instance prefix "fork-a:"/);
      await assert.rejects(() => store.deleteValue("fork-b:key"), /outside instance prefix "fork-a:"/);
      await assert.rejects(() => store.acquireLock("fork-b:lock", 30), /outside instance prefix "fork-a:"/);
      await assert.rejects(() => store.renewLock("fork-b:lock", "token", 30), /outside instance prefix "fork-a:"/);
      await assert.rejects(() => store.releaseLock("fork-b:lock", "token"), /outside instance prefix "fork-a:"/);
    },
  );
});

test("[redis-store] getMeta rejects persisted meta for a different instance", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const redis = new FakeRedis();
      redis.values.set(metaKey(), JSON.stringify(createDefaultMeta(Date.now(), "gateway-token", "fork-b")));
      const store = new RedisStore(redis as never);

      await assert.rejects(
        () => store.getMeta(),
        /Refusing meta for instance "fork-b" while current instance is "fork-a"/,
      );
    },
  );
});

test("[redis-store] write-side meta operations reject mismatched instance ids", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const redis = new FakeRedis();
      redis.evalHandler = () => 1;
      const store = new RedisStore(redis as never);
      const wrongMeta = createDefaultMeta(Date.now(), "gateway-token", "fork-b");

      await assert.rejects(
        () => store.setMeta(wrongMeta),
        /Refusing meta for instance "fork-b" while current instance is "fork-a"/,
      );
      await assert.rejects(
        () => store.createMetaIfAbsent(wrongMeta),
        /Refusing meta for instance "fork-b" while current instance is "fork-a"/,
      );
      await assert.rejects(
        () => store.compareAndSetMeta(1, wrongMeta),
        /Refusing meta for instance "fork-b" while current instance is "fork-a"/,
      );
    },
  );
});

test("[redis-store] configuredMetaKey stays test-only and must still be scoped", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const redis = new FakeRedis();
      const scopedStore = new RedisStore(redis as never, "fork-a:meta:test");
      await scopedStore.setMeta(createDefaultMeta(Date.now(), "gateway-token", "fork-a"));

      const unscopedStore = new RedisStore(redis as never, "meta:test");
      await assert.rejects(
        () => unscopedStore.getMeta(),
        /outside instance prefix "fork-a:"/,
      );
    },
  );

  await withEnv(
    {
      NODE_ENV: "production",
      OPENCLAW_INSTANCE_ID: "fork-a",
    },
    async () => {
      const redis = new FakeRedis();
      const store = new RedisStore(redis as never, "fork-a:meta:test");
      await assert.rejects(
        () => store.getMeta(),
        /configuredMetaKey is only supported in test mode/,
      );
    },
  );
});
