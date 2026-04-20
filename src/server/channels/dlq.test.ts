import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_DLQ_RECORD_TTL_SECONDS,
  getChannelDlqSummary,
  recordChannelDlqFailure,
  type ChannelDlqRecord,
} from "@/server/channels/dlq";
import { _resetLogBuffer, getServerLogs } from "@/server/log";
import {
  channelFailedIndexKey,
  channelFailedKey,
} from "@/server/store/keyspace";
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

test("dlq: upsert preserves firstFailedAt and increments failureCount", async () => {
  await withEnv(async () => {
    const first = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: "slack:evt-upsert-1",
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: "req-1",
      receivedAtMs: Date.now() - 1000,
      error: new Error("first failure"),
    });
    assert.ok(first);
    assert.equal(first.failureCount, 1);
    const firstAt = first.firstFailedAt;

    // Wait 5ms so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));

    const second = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId: "slack:evt-upsert-1",
      phase: "workflow-step-failed",
      terminal: false,
      retryable: true,
      requestId: "req-2",
      receivedAtMs: Date.now() - 1000,
      error: new Error("second failure"),
    });
    assert.ok(second);
    assert.equal(second.failureCount, 2, "second upsert increments count");
    assert.equal(
      second.firstFailedAt,
      firstAt,
      "firstFailedAt must be preserved across upserts",
    );
    assert.ok(second.failedAt >= firstAt);
    assert.equal(second.errorMessage, "second failure");
  });
});

test("dlq: index lists newest first and deduplicates repeated keys", async () => {
  await withEnv(async () => {
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:42",
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("first"),
    });
    await recordChannelDlqFailure({
      channel: "discord",
      deliveryId: "discord:xyz",
      phase: "workflow-start-failed",
      terminal: false,
      retryable: true,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("second"),
    });
    await recordChannelDlqFailure({
      channel: "telegram",
      deliveryId: "telegram:42",
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("third, same delivery"),
    });

    const index = await getStore().getValue<unknown[]>(
      channelFailedIndexKey(),
    );
    assert.ok(Array.isArray(index));
    assert.equal(index.length, 2, "same deliveryId must not duplicate in index");
    const entries = index as Array<{ channel: string; deliveryId: string }>;
    assert.equal(
      entries[0].deliveryId,
      "telegram:42",
      "most-recent entry is first",
    );
    assert.equal(entries[1].deliveryId, "discord:xyz");
  });
});

test("dlq: poison alert fires exactly once at threshold within window", async () => {
  await withEnv(async () => {
    const deliveryId = "slack:poison-evt";
    const poisonCount = () =>
      getServerLogs().filter(
        (entry) => entry.message === "channels.dlq_poison_payload_detected",
      ).length;

    // Fail 4 times — no alert yet.
    for (let i = 0; i < 4; i++) {
      await recordChannelDlqFailure({
        channel: "slack",
        deliveryId,
        phase: "workflow-step-failed",
        terminal: true,
        retryable: false,
        requestId: null,
        receivedAtMs: Date.now(),
        error: new Error(`failure ${i + 1}`),
      });
    }
    assert.equal(poisonCount(), 0, "no alert below threshold");

    // 5th failure crosses the threshold.
    const fifth = await recordChannelDlqFailure({
      channel: "slack",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("failure 5"),
    });
    assert.ok(fifth);
    assert.equal(fifth.failureCount, 5);
    assert.ok(
      typeof fifth.poisonAlertedAt === "number",
      "poisonAlertedAt is stamped on the threshold crossing",
    );
    assert.equal(poisonCount(), 1, "exactly one alert at threshold");

    // 6th failure must NOT re-alert.
    await recordChannelDlqFailure({
      channel: "slack",
      deliveryId,
      phase: "workflow-step-failed",
      terminal: true,
      retryable: false,
      requestId: null,
      receivedAtMs: Date.now(),
      error: new Error("failure 6"),
    });
    assert.equal(poisonCount(), 1, "alert is one-shot per deliveryId");
  });
});

test("dlq: summary aggregates channel counts, terminal count, oldest/newest", async () => {
  await withEnv(async () => {
    const base = Date.now() - 60_000;
    // Seed two DLQ records directly to control failedAt timestamps.
    await getStore().setValue(
      channelFailedKey("slack", "slack:a"),
      {
        channel: "slack",
        deliveryId: "slack:a",
        failedAt: base + 1000,
        firstFailedAt: base,
        failureCount: 3,
        terminal: true,
        retryable: false,
        phase: "workflow-step-failed",
      } satisfies Partial<ChannelDlqRecord>,
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );
    await getStore().setValue(
      channelFailedIndexKey(),
      [
        {
          channel: "slack",
          deliveryId: "slack:a",
          key: channelFailedKey("slack", "slack:a"),
          failedAt: base + 1000,
          phase: "workflow-step-failed",
          terminal: true,
        },
        {
          channel: "telegram",
          deliveryId: "telegram:b",
          key: channelFailedKey("telegram", "telegram:b"),
          failedAt: base + 2000,
          phase: "workflow-start-failed",
          terminal: false,
        },
      ],
      CHANNEL_DLQ_RECORD_TTL_SECONDS,
    );

    const summary = await getChannelDlqSummary();
    assert.equal(summary.indexSize, 2);
    assert.equal(summary.channelCounts.slack, 1);
    assert.equal(summary.channelCounts.telegram, 1);
    assert.equal(summary.channelCounts.whatsapp, 0);
    assert.equal(summary.channelCounts.discord, 0);
    assert.equal(summary.terminalCount, 1);
    assert.equal(summary.oldestFailedAt, base + 1000);
    assert.equal(summary.newestFailedAt, base + 2000);
    assert.notEqual(summary.unavailable, true);
  });
});

test("dlq: summary returns unavailable on store read failure", async () => {
  await withEnv(async () => {
    const store = getStore();
    const originalGetValue = store.getValue.bind(store);
    store.getValue = async () => {
      throw new Error("redis unreachable");
    };
    try {
      const summary = await getChannelDlqSummary();
      assert.equal(summary.unavailable, true);
      assert.equal(summary.indexSize, 0);
      assert.equal(summary.channelCounts.slack, 0);
    } finally {
      store.getValue = originalGetValue;
    }
  });
});
