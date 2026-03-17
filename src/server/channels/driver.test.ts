import assert from "node:assert/strict";
import test from "node:test";

import { type ChannelName } from "@/shared/channels";
import {
  enqueueChannelJob,
  drainChannelQueue,
  getChannelQueueDepth,
  runWithProcessingIndicator,
  type QueuedChannelJob,
  DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS,
} from "@/server/channels/driver";
import {
  channelFailedKey,
  channelProcessingKey,
  channelQueueKey,
} from "@/server/channels/keys";
import {
  getStore,
  getInitializedMeta,
  mutateMeta,
  _resetStoreForTesting,
} from "@/server/store/store";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import type { ExtractedChannelMessage, PlatformAdapter } from "@/server/channels/core/types";
import { RetryableSendError } from "@/server/channels/core/types";
import {
  withHarness,
  type ScenarioHarness,
} from "@/test-utils/harness";
import { chatCompletionsResponse } from "@/test-utils/fake-fetch";
import { getServerLogs, _resetLogBuffer } from "@/server/log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  AI_GATEWAY_API_KEY: "test-key",
};

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

// ---------------------------------------------------------------------------
// Existing tests
// ---------------------------------------------------------------------------

test("enqueueChannelJob deduplicates first-time jobs with the same payload", async () => {
  await withEnv(TEST_ENV, async () => {
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
  });
});

test("enqueueChannelJob allows retries to bypass first-delivery deduplication", async () => {
  await withEnv(TEST_ENV, async () => {
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
  });
});

test("getChannelQueueDepth counts leased jobs in the processing queue", async () => {
  await withEnv(TEST_ENV, async () => {
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
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: drain lock miss
// ---------------------------------------------------------------------------

test("[drain] lock unavailable -> drainChannelQueue returns immediately", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // Acquire the drain lock so drainChannelQueue can't get it
    const lockKey = `openclaw-single:channels:${channel}:drain-lock`;
    const token = await store.acquireLock(lockKey, 60);
    assert.ok(token);

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => null,
      createAdapter: () => { throw new Error("should not be called"); },
    });

    // Job should still be in queue since drain couldn't acquire lock
    assert.equal(await getChannelQueueDepth(channel), 1);

    await store.releaseLock(lockKey, token);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: malformed leased job -> failed queue
// ---------------------------------------------------------------------------

test("[drain] malformed job JSON -> ack and write to failed queue", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // Enqueue raw invalid JSON directly
    await store.enqueue(channelQueueKey(channel), "not-valid-json{{{");

    let adapterCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        adapterCalled = true;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Should not have called the adapter
    assert.equal(adapterCalled, false);
    // Queue should be empty (acked)
    assert.equal(await getChannelQueueDepth(channel), 0);
    // Failed queue should have an entry
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: future nextAttemptAt -> job is parked, not processed
// ---------------------------------------------------------------------------

test("[drain] future nextAttemptAt -> job is parked in processing queue", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    const futureJob = createJob({
      retryCount: 1,
      nextAttemptAt: Date.now() + 60_000,
    });
    await enqueueChannelJob(channel, futureJob);

    let processCount = 0;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        processCount += 1;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Job should NOT have been processed
    assert.equal(processCount, 0);
    // It should be parked in the processing queue (not lost)
    const processingLen = await store.getQueueLength(channelProcessingKey(channel));
    assert.ok(processingLen >= 1, "Parked job should be in processing queue");
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: enqueueChannelJob with explicit dedupId
// ---------------------------------------------------------------------------

test("[enqueue] explicit dedupId -> deduplicates on that ID, not payload hash", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";

    await enqueueChannelJob(channel, createJob({ dedupId: "custom-dedup-1" }));
    // Same dedupId, different payload
    await enqueueChannelJob(channel, createJob({
      payload: { text: "different" },
      dedupId: "custom-dedup-1",
    }));

    assert.equal(await getChannelQueueDepth(channel), 1);

    // Different dedupId, same payload
    await enqueueChannelJob(channel, createJob({ dedupId: "custom-dedup-2" }));
    assert.equal(await getChannelQueueDepth(channel), 2);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: enqueueChannelJob with nextAttemptAt set (retry path)
// ---------------------------------------------------------------------------

test("[enqueue] nextAttemptAt set -> enqueues to front (retry path)", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";

    // Enqueue a normal job first
    await enqueueChannelJob(channel, createJob({ payload: { text: "first" } }));

    // Enqueue a retry with nextAttemptAt — should go to front
    await enqueueChannelJob(channel, createJob({
      payload: { text: "retry" },
      nextAttemptAt: Date.now() + 1000,
    }));

    assert.equal(await getChannelQueueDepth(channel), 2);

    // Dequeue should get the retry first (it was pushed to front)
    const store = getStore();
    const first = await store.dequeue(channelQueueKey(channel));
    assert.ok(first);
    const parsed = JSON.parse(first);
    assert.equal(parsed.payload.text, "retry");
  });
});

// ---------------------------------------------------------------------------
// Failure path: extractMessage throws -> permanently failed without retry
// ---------------------------------------------------------------------------

test("[drain] adapter extractMessage throws -> job permanently failed without retry", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    let sendReplyCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          throw new Error("payload_parse_failure");
        },
        sendReply: async () => {
          sendReplyCalled = true;
        },
      }),
    });

    // sendReply should NOT have been called
    assert.equal(sendReplyCalled, false);
    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Failed queue should have exactly 1 entry
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
    assert.match(parsed.error, /payload_parse_failure/);
    // No second failed queue entry
    const dlEntry2 = await store.dequeue(channelFailedKey(channel));
    assert.equal(dlEntry2, null);
  });
});

// ---------------------------------------------------------------------------
// Failure path: getConfig returns null -> permanently failed (not configured)
// ---------------------------------------------------------------------------

test("[drain] getConfig returns null -> job permanently failed with not_configured error", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => null,
      createAdapter: () => {
        throw new Error("createAdapter should not be called");
      },
    });

    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Failed queue should have 1 entry with not_configured error
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.ok(dlEntry);
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
    assert.match(parsed.error, /not_configured/);
  });
});

// ---------------------------------------------------------------------------
// Failure path: multiple malformed jobs in sequence -> all permanently failed
// ---------------------------------------------------------------------------

test("[drain] multiple malformed jobs -> all permanently failed, adapter never called", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";
    const store = getStore();

    // Enqueue 3 malformed JSON strings directly
    await store.enqueue(channelQueueKey(channel), "bad-json-1");
    await store.enqueue(channelQueueKey(channel), "bad-json-2");
    await store.enqueue(channelQueueKey(channel), "bad-json-3");

    let adapterCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => {
        adapterCalled = true;
        return {} as PlatformAdapter<unknown, ExtractedChannelMessage>;
      },
    });

    // Adapter should never have been called
    assert.equal(adapterCalled, false);
    // Main and processing queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Failed queue should have exactly 3 entries
    const dl1 = await store.dequeue(channelFailedKey(channel));
    const dl2 = await store.dequeue(channelFailedKey(channel));
    const dl3 = await store.dequeue(channelFailedKey(channel));
    assert.ok(dl1);
    assert.ok(dl2);
    assert.ok(dl3);
    const dl4 = await store.dequeue(channelFailedKey(channel));
    assert.equal(dl4, null);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: retry job with past nextAttemptAt -> processed normally
// ---------------------------------------------------------------------------

test("[drain] job with nextAttemptAt in the past -> processed, not parked", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    const pastJob = createJob({
      retryCount: 8,
      nextAttemptAt: Date.now() - 1_000,
    });
    await enqueueChannelJob(channel, pastJob);

    let extractMessageCalled = false;
    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          extractMessageCalled = true;
          // Return a skip to avoid needing full sandbox mocks
          return { kind: "skip" as const, reason: "test-skip" };
        },
        sendReply: async () => {},
      }),
    });

    // The adapter's extractMessage should have been called (job was processed)
    assert.equal(extractMessageCalled, true);
    // Queues should be empty after processing
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
  });
});

// ---------------------------------------------------------------------------
// Retry semantics: RetryableChannelError triggers retry, permanent does not
// ---------------------------------------------------------------------------

test("[drain] retryable error (TimeoutError) -> job requeued in processing, not permanently failed", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          const err = new Error("request timed out");
          err.name = "TimeoutError";
          throw err;
        },
        sendReply: async () => {},
      }),
    });

    // Main queue should be empty (job was leased)
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    // Processing queue should have the retried job (parked with future visibility)
    assert.ok(
      (await store.getQueueLength(channelProcessingKey(channel))) >= 1,
      "Retried job should be parked in processing queue",
    );
    // Failed queue should be empty (not a permanent failure)
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.equal(dlEntry, null, "Should NOT be permanently failed on retryable error");
  });
});

test("[drain] RetryableSendError triggers retry, not failed", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          throw new RetryableSendError("platform_rate_limited", {
            retryAfterSeconds: 30,
          });
        },
        sendReply: async () => {},
      }),
    });

    // Processing queue should hold the retried job
    assert.ok(
      (await store.getQueueLength(channelProcessingKey(channel))) >= 1,
      "Retried job should be parked in processing queue",
    );
    // Failed queue should be empty
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.equal(dlEntry, null, "RetryableSendError should not failed");
  });
});

test("[drain] permanent error (plain Error) -> permanently failed immediately, no retry", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";
    const store = getStore();

    await enqueueChannelJob(channel, createJob());

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          throw new Error("permanent_auth_failure");
        },
        sendReply: async () => {},
      }),
    });

    // Both queues should be empty (job acked after failed)
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
    // Failed queue should have exactly 1 entry
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.ok(dlEntry, "Permanent error should produce a failed entry");
    const parsed = JSON.parse(dlEntry);
    assert.match(parsed.error, /permanent_auth_failure/);
    assert.equal(parsed.channel, channel);
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff: retry delays double up to 5min cap
// ---------------------------------------------------------------------------

test("[drain] exponential backoff: retry delays double, capped at 5 minutes", async () => {
  // Base delay = 1000ms, so:
  //   retry 1 (previousRetryCount=0): 1000 * 2^0 = 1000ms
  //   retry 2 (previousRetryCount=1): 1000 * 2^1 = 2000ms
  //   retry 3 (previousRetryCount=2): 1000 * 2^2 = 4000ms
  //   ...
  //   retry 8 (previousRetryCount=7): 1000 * 2^7 = 128000ms

  const expectedDelays = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

  for (let round = 0; round < expectedDelays.length; round++) {
    await withEnv(TEST_ENV, async () => {
      const channel: ChannelName = "slack";

      const job = createJob({ retryCount: round });
      // Set nextAttemptAt to the past so the job is eligible for processing
      if (round > 0) {
        job.nextAttemptAt = Date.now() - 1000;
      }

      await enqueueChannelJob(channel, job);
      const beforeDrain = Date.now();

      await drainChannelQueue({
        channel,
        getConfig: () => ({ configured: true }),
        createAdapter: () => ({
          extractMessage: () => {
            const err = new Error("fetch failed");
            throw err;
          },
          sendReply: async () => {},
        }),
      });

      const store = getStore();

      // The job should be retried (parked in processing queue)
      const processingLen = await store.getQueueLength(channelProcessingKey(channel));
      assert.ok(processingLen >= 1, `Round ${round}: job should be in processing queue`);

      // Dequeue the processing entry to inspect the parked lease
      const rawLease = await store.dequeue(channelProcessingKey(channel));
      assert.ok(rawLease, `Round ${round}: should have a processing entry`);

      const lease = JSON.parse(rawLease);
      const innerJob = JSON.parse(lease.job);
      const actualDelay = innerJob.nextAttemptAt - beforeDrain;

      // Allow 500ms tolerance for Date.now() drift during test execution
      assert.ok(
        Math.abs(actualDelay - expectedDelays[round]) < 500,
        `Round ${round}: expected ~${expectedDelays[round]}ms delay, got ${actualDelay}ms`,
      );
      assert.equal(innerJob.retryCount, round + 1);
    });
  }
});

test("[drain] backoff caps at 5 minutes (300000ms)", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // retryCount=7 means previousRetryCount will be 7, giving 2^7 * 1000 = 128000ms
    // retryCount=8 would exceed max retries so test with retryCount=7
    // to verify the cap we need previousRetryCount >= 9: 2^9 * 1000 = 512000 → capped at 300000
    // But MAX_RETRY_COUNT is 8, so the highest we can reach is previousRetryCount=7 (retryCount=7→8)
    // Let's verify with a very high previousRetryCount if the formula was different
    // Actually the cap matters for retryAfterSeconds too. Let's test with retryAfterSeconds > 5min
    // Since RetryableSendError supports retryAfterSeconds, we can test the cap that way.

    const job = createJob({ retryCount: 0 });
    await enqueueChannelJob(channel, job);
    const beforeDrain = Date.now();

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          // retryAfterSeconds of 600 (10 min) should be capped to 5 min
          throw new RetryableSendError("rate_limited", {
            retryAfterSeconds: 600,
          });
        },
        sendReply: async () => {},
      }),
    });

    const rawLease = await store.dequeue(channelProcessingKey(channel));
    assert.ok(rawLease);
    const lease = JSON.parse(rawLease);
    const innerJob = JSON.parse(lease.job);
    const actualDelay = innerJob.nextAttemptAt - beforeDrain;

    // Should be capped at 300000ms (5 minutes), with some tolerance
    assert.ok(
      actualDelay <= 300_500,
      `Delay should be capped at ~300000ms, got ${actualDelay}ms`,
    );
    assert.ok(
      actualDelay >= 299_500,
      `Delay should be at least ~300000ms (cap), got ${actualDelay}ms`,
    );
  });
});

// ---------------------------------------------------------------------------
// Max 8 retries then failed
// ---------------------------------------------------------------------------

test("[drain] max 8 retries exhausted -> permanently failed on next retryable error", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";
    const store = getStore();

    // Seed a job that has already been retried 8 times (the max)
    const job = createJob({
      retryCount: 8,
      nextAttemptAt: Date.now() - 1000, // eligible for processing
    });
    await enqueueChannelJob(channel, job);

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          // This is a retryable error, but retries are exhausted
          const err = new Error("fetch failed");
          throw err;
        },
        sendReply: async () => {},
      }),
    });

    // Both queues should be empty
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);

    // Failed queue should have exactly 1 entry
    const dlEntry = await store.dequeue(channelFailedKey(channel));
    assert.ok(dlEntry, "Exhausted retries should produce a failed entry");
    const parsed = JSON.parse(dlEntry);
    assert.equal(parsed.channel, channel);
    assert.match(parsed.error, /fetch failed/);

    // No second failed entry
    assert.equal(await store.dequeue(channelFailedKey(channel)), null);
  });
});

test("[drain] retryCount 7 still retries (not exhausted yet)", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "telegram";
    const store = getStore();

    const job = createJob({
      retryCount: 7,
      nextAttemptAt: Date.now() - 1000,
    });
    await enqueueChannelJob(channel, job);

    await drainChannelQueue({
      channel,
      getConfig: () => ({ configured: true }),
      createAdapter: () => ({
        extractMessage: () => {
          const err = new Error("fetch failed");
          throw err;
        },
        sendReply: async () => {},
      }),
    });

    // Should be retried (in processing queue), NOT permanently failed
    assert.ok(
      (await store.getQueueLength(channelProcessingKey(channel))) >= 1,
      "RetryCount 7 should still retry",
    );
    assert.equal(
      await store.dequeue(channelFailedKey(channel)),
      null,
      "Should not be permanently failed at retryCount 7",
    );
  });
});

// ---------------------------------------------------------------------------
// Job dedup: same dedup key within visibility window is skipped
// ---------------------------------------------------------------------------

test("[enqueue] same dedup key within TTL window -> second job skipped", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "slack";

    // First enqueue succeeds
    await enqueueChannelJob(channel, createJob({ dedupId: "dedup-window-test" }));
    assert.equal(await getChannelQueueDepth(channel), 1);

    // Second enqueue with same dedupId within the TTL window -> skipped
    await enqueueChannelJob(channel, createJob({
      payload: { text: "different payload" },
      dedupId: "dedup-window-test",
      receivedAt: Date.now() + 1000,
    }));
    assert.equal(await getChannelQueueDepth(channel), 1, "Duplicate should be skipped");

    // Different dedupId -> accepted
    await enqueueChannelJob(channel, createJob({ dedupId: "different-key" }));
    assert.equal(await getChannelQueueDepth(channel), 2, "Different key should be accepted");
  });
});

test("[enqueue] payload-based dedup: identical payloads deduped, different payloads accepted", async () => {
  await withEnv(TEST_ENV, async () => {
    const channel: ChannelName = "discord";

    await enqueueChannelJob(channel, createJob({ payload: { text: "same" } }));
    await enqueueChannelJob(channel, createJob({ payload: { text: "same" } }));
    assert.equal(await getChannelQueueDepth(channel), 1, "Same payload should dedup");

    await enqueueChannelJob(channel, createJob({ payload: { text: "different" } }));
    assert.equal(await getChannelQueueDepth(channel), 2, "Different payload should not dedup");
  });
});

// ---------------------------------------------------------------------------
// Sandbox restore triggered when sandbox not running during drain
// ---------------------------------------------------------------------------

test("[drain] sandbox restore triggered when sandbox not running", async () => {
  await withHarness(async (h) => {
    const channel: ChannelName = "slack";

    // Configure slack channel
    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test-bot-token",
        configuredAt: Date.now(),
      };
    });

    // Install gateway handlers so the full processing path works
    h.installDefaultGatewayHandlers("test reply from restored sandbox");

    // Drive sandbox to running first, then stop it
    await h.driveToRunning();
    const snapshotId = await h.stopToSnapshot();

    const meta = await h.getMeta();
    assert.equal(meta.status, "stopped");
    assert.ok(snapshotId);

    // Enqueue a job while sandbox is stopped
    await enqueueChannelJob(channel, createJob());

    // Install the gateway ready handler for the restore flow
    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await drainChannelQueue<
        { signingSecret: string; botToken: string; configuredAt: number },
        { text: string },
        ExtractedChannelMessage
      >({
        channel,
        getConfig: (m) => m.channels.slack,
        createAdapter: () => ({
          extractMessage: (payload: { text: string }) => ({
            kind: "message" as const,
            message: { text: payload.text },
          }),
          sendReply: async () => {},
          getSessionKey: () => "test-session",
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Verify that sandbox was restored (a new sandbox was created from snapshot)
    const postDrainMeta = await h.getMeta();
    assert.equal(postDrainMeta.status, "running", "Sandbox should be running after drain restore");

    // Verify a restore event occurred (create from snapshot)
    const restoreEvents = h.controller.eventsOfKind("restore");
    assert.ok(
      restoreEvents.length >= 1,
      "At least one restore event should have occurred",
    );

    // Verify the gateway was called (message was forwarded)
    const gatewayRequests = h.fakeFetch
      .requests()
      .filter((r) => r.url.includes("/v1/chat/completions"));
    assert.ok(
      gatewayRequests.length >= 1,
      "Gateway should have been called after restore",
    );

    // Queue should be drained
    const store = h.getStore();
    assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
    assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
  });
});

// ---------------------------------------------------------------------------
// processChannelJob: sandbox warmup timeout -> RetryableChannelError
// ---------------------------------------------------------------------------

test("[drain] sandbox warmup timeout -> requeued with retryAfterSeconds=15", async () => {
  await withHarness(async (h) => {
    const channel: ChannelName = "slack";

    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test-bot-token",
        configuredAt: Date.now(),
      };
    });

    // Install full handlers so background restore completes cleanly
    h.installDefaultGatewayHandlers();
    await h.driveToRunning();
    await h.stopToSnapshot();

    await enqueueChannelJob(channel, createJob());

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;
    const beforeDrain = Date.now();

    try {
      await drainChannelQueue({
        channel,
        getConfig: (m) => m.channels.slack,
        createAdapter: () => ({
          extractMessage: (payload: { text: string }) => ({
            kind: "message" as const,
            message: { text: payload.text },
          }),
          sendReply: async () => {},
        }),
        // Very short timeout: sandbox is "restoring" so probeGatewayReady
        // returns { ready: false } immediately (status not in running/setup/booting).
        // The 1-second poll interval in ensureSandboxReady means one iteration,
        // then the deadline passes and it throws ApiError(504).
        sandboxReadyTimeoutMs: 100,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const store = h.getStore();

    // Job should be in processing queue (retried), NOT permanently failed
    assert.ok(
      (await store.getQueueLength(channelProcessingKey(channel))) >= 1,
      "Job should be in processing queue (retried after sandbox timeout)",
    );
    assert.equal(
      await store.dequeue(channelFailedKey(channel)),
      null,
      "Should NOT be permanently failed on sandbox timeout",
    );

    // Parse the retried job and check retryAfterSeconds was honored
    const rawLease = await store.dequeue(channelProcessingKey(channel));
    assert.ok(rawLease);
    const lease = JSON.parse(rawLease);
    const innerJob = JSON.parse(lease.job);
    assert.equal(innerJob.retryCount, 1);

    // computeRetryDelayMs: max(exponential=1000ms, retryAfter=15000ms) = 15000ms
    const delay = innerJob.nextAttemptAt - beforeDrain;
    assert.ok(
      delay >= 13_000 && delay <= 18_000,
      `Expected ~15000ms retry delay (retryAfterSeconds=15), got ${delay}ms`,
    );
    assert.match(
      innerJob.lastError,
      /sandbox_not_ready/,
      "lastError should reference sandbox_not_ready",
    );
  });
});

// ---------------------------------------------------------------------------
// Wake-from-sleep: full retry cycle (unit-level simulation)
// ---------------------------------------------------------------------------

test("[drain] wake-from-sleep: first attempt times out, retry succeeds after sandbox wakes", async () => {
  await withHarness(async (h) => {
    const channel: ChannelName = "slack";

    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test-bot-token",
        configuredAt: Date.now(),
      };
    });

    // Install full handlers so background restore and second drain succeed
    h.installDefaultGatewayHandlers("wake-cycle-reply");
    await h.driveToRunning();
    await h.stopToSnapshot();

    await enqueueChannelJob(channel, createJob({ payload: { text: "wake-cycle" } }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      // --- First drain: sandbox stopped, short timeout -> retried ---
      await drainChannelQueue({
        channel,
        getConfig: (m) => m.channels.slack,
        createAdapter: () => ({
          extractMessage: (payload: { text: string }) => ({
            kind: "message" as const,
            message: { text: payload.text },
          }),
          sendReply: async () => {},
        }),
        sandboxReadyTimeoutMs: 100,
      });

      const store = h.getStore();

      // Verify job was retried
      assert.ok(
        (await store.getQueueLength(channelProcessingKey(channel))) >= 1,
        "Job should be retried after first drain timeout",
      );

      // Wait for background restore to complete (FakeSandboxController is instant,
      // so the only delay is the gateway probe in restoreSandboxFromSnapshot).
      for (let i = 0; i < 50; i++) {
        const meta = await h.getMeta();
        if (meta.status === "running") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const meta = await h.getMeta();
      assert.equal(meta.status, "running", "Sandbox should be running after background restore");

      // Move retried job back to main queue with past nextAttemptAt
      const rawLease = await store.dequeue(channelProcessingKey(channel));
      assert.ok(rawLease, "Should have retried job in processing queue");
      const lease = JSON.parse(rawLease);
      const innerJob = JSON.parse(lease.job);
      innerJob.nextAttemptAt = Date.now() - 1000;
      await store.enqueue(channelQueueKey(channel), JSON.stringify(innerJob));

      // --- Second drain: sandbox running -> message delivered ---
      let replySent = false;
      await drainChannelQueue({
        channel,
        getConfig: (m) => m.channels.slack,
        createAdapter: () => ({
          extractMessage: (payload: { text: string }) => ({
            kind: "message" as const,
            message: { text: payload.text },
          }),
          sendReply: async () => {
            replySent = true;
          },
        }),
      });

      // Verify delivery succeeded
      assert.equal(replySent, true, "Reply should have been sent on second drain");

      // Verify queues are empty
      assert.equal(await store.getQueueLength(channelQueueKey(channel)), 0);
      assert.equal(await store.getQueueLength(channelProcessingKey(channel)), 0);
      assert.equal(
        await store.dequeue(channelFailedKey(channel)),
        null,
        "No failed entries after successful delivery",
      );

      // Verify gateway was called
      const gatewayRequests = h.fakeFetch
        .requests()
        .filter((r) => r.url.includes("/v1/chat/completions"));
      assert.ok(
        gatewayRequests.length >= 1,
        "Gateway should have been called during second drain",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Structured log events at wake, gateway, and send phases
// ---------------------------------------------------------------------------

test("[processChannelJob] structured log events at wake, gateway, and send phases", async () => {
  await withHarness(async (h) => {
    const channel: ChannelName = "slack";

    await h.mutateMeta((meta) => {
      meta.channels.slack = {
        signingSecret: "test-signing-secret",
        botToken: "xoxb-test-bot-token",
        configuredAt: Date.now(),
      };
    });

    h.installDefaultGatewayHandlers("log-test-reply");
    await h.driveToRunning();

    await enqueueChannelJob(channel, createJob({ payload: { text: "log-test" } }));

    // Clear log buffer to only capture logs from the drain
    _resetLogBuffer();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = h.fakeFetch.fetch;

    try {
      await drainChannelQueue({
        channel,
        getConfig: (m) => m.channels.slack,
        createAdapter: () => ({
          extractMessage: (payload: { text: string }) => ({
            kind: "message" as const,
            message: { text: payload.text },
          }),
          sendReply: async () => {},
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const logs = getServerLogs();
    const logMessages = logs.map((l) => l.message);

    // Verify structured log events at each delivery phase
    assert.ok(
      logMessages.includes("channels.wake_requested"),
      "Should emit channels.wake_requested log event",
    );
    assert.ok(
      logMessages.includes("channels.wake_ready"),
      "Should emit channels.wake_ready log event",
    );
    assert.ok(
      logMessages.includes("channels.gateway_request_started"),
      "Should emit channels.gateway_request_started log event",
    );
    assert.ok(
      logMessages.includes("channels.platform_reply_sent"),
      "Should emit channels.platform_reply_sent log event",
    );
    assert.ok(
      logMessages.includes("channels.delivery_success"),
      "Should emit channels.delivery_success log event",
    );

    // Verify wake_requested includes channel and timeout data
    const wakeLog = logs.find((l) => l.message === "channels.wake_requested");
    assert.ok(wakeLog?.data);
    const wakeData = wakeLog.data as Record<string, unknown>;
    assert.equal(wakeData.channel, "slack");
    assert.equal(wakeData.sandboxReadyTimeoutMs, DEFAULT_CHANNEL_SANDBOX_READY_TIMEOUT_MS);

    // Verify gateway_request_started includes channel
    const gwLog = logs.find((l) => l.message === "channels.gateway_request_started");
    assert.ok(gwLog?.data);
    assert.equal((gwLog.data as Record<string, unknown>).channel, "slack");
  });
});

// ---------------------------------------------------------------------------
// runWithProcessingIndicator lifecycle tests
// ---------------------------------------------------------------------------

test("runWithProcessingIndicator starts and stops the new indicator path", async () => {
  const events: string[] = [];

  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async startProcessingIndicator() {
      events.push("start");
      return {
        async stop() {
          events.push("stop");
        },
      };
    },
  };

  const result = await runWithProcessingIndicator(
    {
      channel: "slack",
      adapter,
      message: { text: "hello" },
      delayMs: 0,
    },
    async () => {
      events.push("run");
      return "ok";
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(events, ["start", "run", "stop"]);
});

test("runWithProcessingIndicator avoids flashing the indicator on fast runs", async () => {
  const events: string[] = [];

  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async startProcessingIndicator() {
      events.push("start");
      return {
        async stop() {
          events.push("stop");
        },
      };
    },
  };

  await runWithProcessingIndicator(
    {
      channel: "slack",
      adapter,
      message: { text: "hello" },
      delayMs: 25,
    },
    async () => {},
  );

  assert.deepEqual(events, []);
});

test("runWithProcessingIndicator falls back to legacy typing and always clears it", async () => {
  const events: string[] = [];

  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async sendTypingIndicator() {
      events.push("legacy-start");
    },
    async clearTypingIndicator() {
      events.push("legacy-stop");
    },
  };

  await assert.rejects(
    runWithProcessingIndicator(
      {
        channel: "telegram",
        adapter,
        message: { text: "hello" },
        delayMs: 0,
      },
      async () => {
        events.push("run");
        throw new Error("boom");
      },
    ),
    /boom/,
  );

  assert.deepEqual(events, ["legacy-start", "run", "legacy-stop"]);
});
