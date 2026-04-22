import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelName } from "@/shared/channels";
import { _setInstanceIdOverrideForTesting, getOpenclawInstanceId } from "@/server/env";
import {
  adminSecretKey,
  assertScopedRedisKey,
  channelDedupKey,
  channelDrainLockKey,
  channelFailedKey,
  channelProcessingKey,
  channelQueueKey,
  channelSessionHistoryKey,
  channelUserMessageDedupKey,
  codexTokenRefreshLockKey,
  cronJobsKey,
  cronNextWakeKey,
  debugLockKey,
  initLockKey,
  instanceKeyPrefix,
  learningLockKey,
  lifecycleLockKey,
  metaKey,
  setupProgressKey,
  startLockKey,
  tokenRefreshLockKey,
} from "@/server/store/keyspace";

const CHANNELS: ChannelName[] = ["slack", "telegram", "discord"];

function withInstanceId<T>(
  instanceId: string | null,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const original = process.env.OPENCLAW_INSTANCE_ID;
  if (instanceId === null) {
    delete process.env.OPENCLAW_INSTANCE_ID;
  } else {
    process.env.OPENCLAW_INSTANCE_ID = instanceId;
  }
  _setInstanceIdOverrideForTesting(null);

  const restore = () => {
    if (original === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = original;
    }
    _setInstanceIdOverrideForTesting(null);
  };

  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result instanceof Promise) {
    return result.finally(restore);
  }

  restore();
  return result;
}

test("keyspace: default instance id preserves existing keys", () => {
  withInstanceId(null, () => {
    assert.equal(getOpenclawInstanceId(), "openclaw-single");
    assert.equal(instanceKeyPrefix(), "openclaw-single:");
    assert.equal(metaKey(), "openclaw-single:meta");
    assert.equal(initLockKey(), "openclaw-single:lock:init");
    assert.equal(lifecycleLockKey(), "openclaw-single:lock:lifecycle");
    assert.equal(startLockKey(), "openclaw-single:lock:start");
    assert.equal(tokenRefreshLockKey(), "openclaw-single:lock:token-refresh");
    assert.equal(
      codexTokenRefreshLockKey(),
      "openclaw-single:lock:codex-token-refresh",
    );
    assert.equal(cronNextWakeKey(), "openclaw-single:cron-next-wake-ms");
    assert.equal(cronJobsKey(), "openclaw-single:cron-jobs-json");
    assert.equal(adminSecretKey(), "openclaw-single:admin-secret");
    assert.equal(learningLockKey(), "openclaw-single:lock:learning-refresh");
    assert.equal(debugLockKey(), "openclaw-single:lock:debug-timing");
    assert.equal(setupProgressKey(), "openclaw-single:setup-progress");
  });
});

test("keyspace: custom instance id updates all key prefixes lazily", () => {
  withInstanceId("fork-a", () => {
    assert.equal(getOpenclawInstanceId(), "fork-a");
    assert.equal(instanceKeyPrefix(), "fork-a:");
    assert.equal(metaKey(), "fork-a:meta");
    assert.equal(initLockKey(), "fork-a:lock:init");
    assert.equal(adminSecretKey(), "fork-a:admin-secret");
    assert.equal(setupProgressKey("fork-a"), "fork-a:setup-progress");

    for (const channel of CHANNELS) {
      assert.equal(channelQueueKey(channel), `fork-a:channels:${channel}:queue`);
      assert.equal(
        channelProcessingKey(channel),
        `fork-a:channels:${channel}:processing`,
      );
      assert.equal(channelFailedKey(channel), `fork-a:channels:${channel}:failed`);
      assert.equal(
        channelDrainLockKey(channel),
        `fork-a:channels:${channel}:drain-lock`,
      );
      assert.equal(
        channelSessionHistoryKey(channel, "session-1"),
        `fork-a:channels:${channel}:history:session-1`,
      );
      assert.equal(
        channelDedupKey(channel, "dedup-1"),
        `fork-a:channels:${channel}:dedup:dedup-1`,
      );
      assert.equal(
        channelUserMessageDedupKey(channel, "C123", "1234.5"),
        `fork-a:channels:${channel}:user-message-dedup:C123:1234.5`,
      );
    }

    _setInstanceIdOverrideForTesting("fork-b");
    assert.equal(instanceKeyPrefix(), "fork-b:");
    assert.equal(metaKey(), "fork-b:meta");
    assert.equal(channelQueueKey("slack"), "fork-b:channels:slack:queue");
    assert.equal(setupProgressKey("fork-b"), "fork-b:setup-progress");
  });
});

test("keyspace: assertScopedRedisKey accepts keys in the current instance prefix", () => {
  withInstanceId("fork-a", () => {
    assert.doesNotThrow(() => assertScopedRedisKey("fork-a:meta"));
    assert.doesNotThrow(() => assertScopedRedisKey("fork-a:channels:slack:queue"));
  });
});

test("keyspace: assertScopedRedisKey rejects keys outside the current instance prefix", () => {
  withInstanceId("fork-a", () => {
    assert.throws(
      () => assertScopedRedisKey("fork-b:meta"),
      /outside instance prefix "fork-a:"/,
    );
    assert.throws(
      () => assertScopedRedisKey("meta"),
      /outside instance prefix "fork-a:"/,
    );
  });
});

test("keyspace: blank instance id throws", () => {
  withInstanceId("   ", () => {
    assert.throws(() => getOpenclawInstanceId(), /OPENCLAW_INSTANCE_ID must not be blank/);
    assert.throws(() => metaKey(), /OPENCLAW_INSTANCE_ID must not be blank/);
    assert.throws(() => channelQueueKey("slack"), /OPENCLAW_INSTANCE_ID must not be blank/);
    assert.throws(() => setupProgressKey("   "), /OPENCLAW_INSTANCE_ID must not be blank/);
  });
});

test("keyspace: instance id token rejects embedded separators", () => {
  withInstanceId("fork-a:queue", () => {
    assert.throws(() => getOpenclawInstanceId(), /OPENCLAW_INSTANCE_ID must not contain ':'/);
    assert.throws(() => metaKey(), /OPENCLAW_INSTANCE_ID must not contain ':'/);
    assert.throws(() => channelQueueKey("slack"), /OPENCLAW_INSTANCE_ID must not contain ':'/);
    assert.throws(() => setupProgressKey("fork-a:queue"), /OPENCLAW_INSTANCE_ID must not contain ':'/);
  });
});
