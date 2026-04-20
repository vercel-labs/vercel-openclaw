import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
  SLACK_USER_MESSAGE_DEDUP_LOCK_TTL_SECONDS,
  tryAcquireChannelDedupLock,
} from "@/server/channels/dedup";
import { _resetLogBuffer, getServerLogs } from "@/server/log";
import { _resetStoreForTesting, getStore } from "@/server/store/store";

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
};

async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(TEST_ENV)) {
    originals[key] = process.env[key];
    if (TEST_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = TEST_ENV[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    _resetLogBuffer();
  }
}

test("dedup: fresh acquire returns { kind: 'acquired', lock } with a token", async () => {
  await withEnv(async () => {
    const result = await tryAcquireChannelDedupLock({
      channel: "slack",
      key: "openclaw-single:test-dedup-1",
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: "req-1",
      dedupId: "evt-1",
    });
    assert.equal(result.kind, "acquired");
    assert.ok(result.kind === "acquired");
    assert.ok(typeof result.lock.token === "string" && result.lock.token.length > 0);
  });
});

test("dedup: second acquire on the same key returns 'duplicate'", async () => {
  await withEnv(async () => {
    const first = await tryAcquireChannelDedupLock({
      channel: "slack",
      key: "openclaw-single:test-dedup-dup",
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: "req-1",
      dedupId: "evt-1",
    });
    assert.equal(first.kind, "acquired");
    const second = await tryAcquireChannelDedupLock({
      channel: "slack",
      key: "openclaw-single:test-dedup-dup",
      ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
      requestId: "req-2",
      dedupId: "evt-1",
    });
    assert.equal(second.kind, "duplicate");
  });
});

test("dedup: store-level failure returns 'degraded' and emits log", async () => {
  await withEnv(async () => {
    const store = getStore();
    const originalAcquire = store.acquireLock.bind(store);
    store.acquireLock = async () => {
      throw new Error("redis unreachable");
    };
    try {
      const result = await tryAcquireChannelDedupLock({
        channel: "telegram",
        key: "openclaw-single:test-dedup-degraded",
        ttlSeconds: CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS,
        requestId: "req-9",
        dedupId: "update-9",
        lockKind: "delivery",
      });
      assert.equal(result.kind, "degraded");
      assert.ok(result.kind === "degraded");
      assert.match(result.error, /redis unreachable/);

      const degradedLogs = getServerLogs().filter(
        (entry) => entry.message === "channels.dedup_lock_acquire_failed_degraded",
      );
      assert.equal(degradedLogs.length, 1);
      assert.equal(degradedLogs[0].data?.channel, "telegram");
      assert.equal(degradedLogs[0].data?.lockKind, "delivery");
      assert.equal(degradedLogs[0].data?.action, "continue_without_dedup");
    } finally {
      store.acquireLock = originalAcquire;
    }
  });
});

test("dedup: TTL constants are correct for platform retry windows", () => {
  // 1 hour covers Slack (~10min), Telegram (~30min), WhatsApp (~a few min).
  assert.equal(CHANNEL_DELIVERY_DEDUP_LOCK_TTL_SECONDS, 60 * 60);
  // Slack user-message lock collapses dual-event app_mention + message
  // for the full conversation day.
  assert.equal(SLACK_USER_MESSAGE_DEDUP_LOCK_TTL_SECONDS, 24 * 60 * 60);
});
