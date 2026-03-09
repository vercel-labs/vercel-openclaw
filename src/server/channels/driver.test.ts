import assert from "node:assert/strict";
import test from "node:test";

import { type ChannelName } from "@/shared/channels";
import {
  enqueueChannelJob,
  getChannelQueueDepth,
  type QueuedChannelJob,
} from "@/server/channels/driver";
import { channelProcessingKey, channelQueueKey } from "@/server/channels/keys";
import { getStore, _resetStoreForTesting } from "@/server/store/store";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
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
  }
}

function createJob(
  overrides: Partial<QueuedChannelJob<{ text: string }>> = {},
): QueuedChannelJob<{ text: string }> {
  return {
    payload: { text: "hello" },
    receivedAt: 1,
    origin: "https://app.test",
    ...overrides,
  };
}

test("enqueueChannelJob deduplicates first-time jobs with the same payload", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    async () => {
      const channel: ChannelName = "slack";

      await enqueueChannelJob(channel, createJob());
      await enqueueChannelJob(
        channel,
        createJob({
          receivedAt: 2,
          origin: "https://duplicate.test",
        }),
      );

      assert.equal(await getChannelQueueDepth(channel), 1);
    },
  );
});

test("enqueueChannelJob allows retries to bypass first-delivery deduplication", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    async () => {
      const channel: ChannelName = "slack";

      await enqueueChannelJob(channel, createJob());
      await enqueueChannelJob(
        channel,
        createJob({
          retryCount: 1,
          nextAttemptAt: Date.now() + 10_000,
        }),
      );

      assert.equal(await getChannelQueueDepth(channel), 2);
    },
  );
});

test("getChannelQueueDepth counts leased jobs in the processing queue", async () => {
  await withEnv(
    {
      NODE_ENV: "test",
      VERCEL: undefined,
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
    },
    async () => {
      const channel: ChannelName = "slack";
      const store = getStore();

      await enqueueChannelJob(channel, createJob());
      const leasedValue = await store.leaseQueueItem(
        channelQueueKey(channel),
        channelProcessingKey(channel),
        Date.now(),
        60,
      );

      assert.ok(leasedValue);
      assert.equal(await getChannelQueueDepth(channel), 1);

      assert.equal(
        await store.ackQueueItem(channelProcessingKey(channel), leasedValue ?? ""),
        true,
      );
      assert.equal(await getChannelQueueDepth(channel), 0);
    },
  );
});
