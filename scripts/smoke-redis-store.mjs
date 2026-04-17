#!/usr/bin/env node
/**
 * End-to-end smoke test for the new RedisStore (ioredis-based).
 *
 * Connects to REDIS_URL (default redis://localhost:6379), exercises every
 * Store method against a throwaway instance prefix, and tears down all keys
 * it created before exiting.
 *
 * Usage:
 *   redis-server &
 *   node scripts/smoke-redis-store.mjs
 *   # or: REDIS_URL=redis://host:port node scripts/smoke-redis-store.mjs
 */
import { randomUUID } from "node:crypto";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const INSTANCE_ID = `smoke-${randomUUID().slice(0, 8)}`;

process.env.REDIS_URL = REDIS_URL;
process.env.OPENCLAW_INSTANCE_ID = INSTANCE_ID;
process.env.VERCEL = "1";
process.env.NODE_ENV = "production";

// Run this script as:
//   node --import tsx scripts/smoke-redis-store.mjs
// so tsx resolves .ts imports.
const { RedisStore } = await import("../src/server/store/redis-store.ts");
const { createDefaultMeta } = await import("../src/shared/types.ts");

let failures = 0;
const logs = [];
function step(name, fn) {
  return (async () => {
    const t0 = Date.now();
    try {
      await fn();
      logs.push(`✔ ${name} (${Date.now() - t0}ms)`);
    } catch (err) {
      failures++;
      logs.push(`✖ ${name} (${Date.now() - t0}ms): ${err?.message ?? err}`);
    }
  })();
}

const store = RedisStore.fromEnv();
if (!store) {
  console.error("RedisStore.fromEnv() returned null — REDIS_URL missing?");
  process.exit(2);
}

const scoped = (suffix) => `${INSTANCE_ID}:${suffix}`;
const meta0 = createDefaultMeta(Date.now(), randomUUID(), INSTANCE_ID);

await step("createMetaIfAbsent(absent) returns true", async () => {
  const ok = await store.createMetaIfAbsent(meta0);
  if (!ok) throw new Error("expected true");
});

await step("createMetaIfAbsent(second call) returns false (NX)", async () => {
  const ok = await store.createMetaIfAbsent(meta0);
  if (ok) throw new Error("expected false");
});

await step("getMeta() returns stored meta", async () => {
  const got = await store.getMeta();
  if (!got || got.id !== INSTANCE_ID || got.version !== meta0.version) {
    throw new Error(`unexpected meta: ${JSON.stringify(got)}`);
  }
});

await step("compareAndSetMeta happy path", async () => {
  const next = { ...meta0, version: meta0.version + 1, status: "stopped" };
  const ok = await store.compareAndSetMeta(meta0.version, next);
  if (!ok) throw new Error("expected true");
  const got = await store.getMeta();
  if (got?.status !== "stopped") throw new Error(`wrong status: ${got?.status}`);
});

await step("compareAndSetMeta wrong version returns false", async () => {
  const bad = { ...meta0, version: 999, status: "error" };
  const ok = await store.compareAndSetMeta(42, bad);
  if (ok) throw new Error("expected false");
});

await step("setValue / getValue JSON roundtrip", async () => {
  const key = scoped("smoke-value");
  await store.setValue(key, { foo: 1, bar: "baz" });
  const got = await store.getValue(key);
  if (got?.foo !== 1 || got?.bar !== "baz") {
    throw new Error(`roundtrip mismatch: ${JSON.stringify(got)}`);
  }
});

await step("setValue with TTL expires", async () => {
  const key = scoped("smoke-ttl");
  await store.setValue(key, "short-lived", 1);
  const hit = await store.getValue(key);
  if (hit !== "short-lived") throw new Error("missing before TTL");
  await new Promise((r) => setTimeout(r, 1300));
  const miss = await store.getValue(key);
  if (miss !== null) throw new Error(`expected expired, got ${miss}`);
});

await step("deleteValue removes key", async () => {
  const key = scoped("smoke-del");
  await store.setValue(key, 42);
  await store.deleteValue(key);
  const got = await store.getValue(key);
  if (got !== null) throw new Error(`expected null, got ${got}`);
});

await step("acquireLock grants + blocks + releases", async () => {
  const key = scoped("smoke-lock");
  const tokenA = await store.acquireLock(key, 10);
  if (!tokenA) throw new Error("first acquire must succeed");
  const tokenB = await store.acquireLock(key, 10);
  if (tokenB) throw new Error("second acquire must be blocked");
  await store.releaseLock(key, tokenA);
  const tokenC = await store.acquireLock(key, 10);
  if (!tokenC) throw new Error("third acquire must succeed after release");
  await store.releaseLock(key, tokenC);
});

await step("renewLock with correct token returns true", async () => {
  const key = scoped("smoke-renew");
  const token = await store.acquireLock(key, 2);
  if (!token) throw new Error("acquire failed");
  const renewed = await store.renewLock(key, token, 10);
  if (!renewed) throw new Error("renew should succeed");
  await store.releaseLock(key, token);
});

await step("renewLock with wrong token returns false", async () => {
  const key = scoped("smoke-renew-bad");
  const token = await store.acquireLock(key, 10);
  if (!token) throw new Error("acquire failed");
  const renewed = await store.renewLock(key, "wrong-token", 10);
  if (renewed) throw new Error("renew with wrong token must fail");
  await store.releaseLock(key, token);
});

await step("releaseLock with wrong token is a no-op", async () => {
  const key = scoped("smoke-rel-bad");
  const token = await store.acquireLock(key, 10);
  if (!token) throw new Error("acquire failed");
  await store.releaseLock(key, "wrong-token");
  const blocked = await store.acquireLock(key, 10);
  if (blocked) throw new Error("wrong-token release should not free the lock");
  await store.releaseLock(key, token);
});

// Final cleanup: nuke every key we scoped under this instance prefix.
await step("cleanup: SCAN + DEL keys under smoke prefix", async () => {
  // Reach into the shared client via a clean Redis connection.
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  try {
    const stream = redis.scanStream({ match: `${INSTANCE_ID}:*`, count: 200 });
    await new Promise((resolve, reject) => {
      stream.on("data", async (keys) => {
        if (keys.length > 0) {
          stream.pause();
          try {
            await redis.del(...keys);
          } catch (e) {
            reject(e);
            return;
          }
          stream.resume();
        }
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  } finally {
    redis.disconnect();
  }
});

for (const line of logs) console.log(line);
console.log("---");
console.log(`instance: ${INSTANCE_ID}  url: ${REDIS_URL}`);
if (failures > 0) {
  console.error(`${failures} step(s) failed.`);
  process.exit(1);
}
console.log("all steps passed");

// Close shared ioredis connection so Node exits cleanly.
process.exit(0);
