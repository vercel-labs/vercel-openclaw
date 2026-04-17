import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithBootMessages,
} from "@/server/channels/core/boot-messages";
import type {
  ExtractedChannelMessage,
  PlatformAdapter,
} from "@/server/channels/core/types";
import {
  _resetStoreForTesting,
  mutateMeta,
} from "@/server/store/store";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import { FakeSandboxController } from "@/test-utils/fake-sandbox-controller";
import { _resetLogBuffer } from "@/server/log";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
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
    _resetLogBuffer();
  }
}

type BootMessageLog = {
  action: "send" | "update" | "clear";
  text?: string;
};

function createTrackingAdapter(): {
  adapter: PlatformAdapter<unknown, ExtractedChannelMessage>;
  log: BootMessageLog[];
} {
  const log: BootMessageLog[] = [];

  const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
    extractMessage: () => ({ kind: "skip", reason: "test" }),
    sendReply: async () => {},
    async sendBootMessage(_message, text) {
      log.push({ action: "send", text });
      return {
        async update(newText: string) {
          log.push({ action: "update", text: newText });
        },
        async clear() {
          log.push({ action: "clear" });
        },
      };
    },
  };

  return { adapter, log };
}

function createMessage(): ExtractedChannelMessage {
  return { text: "hello" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("boot-messages: no boot message when sandbox is already running", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-running";
    });

    const { adapter, log } = createTrackingAdapter();

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    assert.equal(result.bootMessageSent, false);
    assert.equal(log.length, 0);
  });
});

test("boot-messages: no boot message when adapter lacks sendBootMessage", async () => {
  await withEnv(TEST_ENV, async () => {
    const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
      extractMessage: () => ({ kind: "skip", reason: "test" }),
      sendReply: async () => {},
      // No sendBootMessage
    };

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    assert.equal(result.bootMessageSent, false);
  });
});

test("boot-messages: sends boot message and clears on running", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    // Start stopped, then transition to running after first poll
    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    // Override ensureSandboxRunning behavior by mutating meta on poll
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("not-openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      // Simulate sandbox becoming running after a short delay
      setTimeout(async () => {
        await mutateMeta((meta) => {
          meta.status = "running";
          meta.sandboxId = "sbx-1";
        });
        // Now make gateway probe succeed
        globalThis.fetch = (async () => {
          return new Response("openclaw-app", { status: 200 });
        }) as typeof fetch;
      }, 200);

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);
      // Should have sent initial boot message
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
      // Clear now happens asynchronously after the wake path returns.
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(log.some((e) => e.action === "clear"), "should have cleared boot message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: boot message cleared after successful restore", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    // Let the fake controller restore instantly and gateway probe succeed
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const result = await runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      assert.equal(result.bootMessageSent, true);
      // Boot message must always be cleared (even on success)
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(log.some((e) => e.action === "clear"), "should have cleared after restore");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: sendBootMessage failure is non-fatal", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const adapter: PlatformAdapter<unknown, ExtractedChannelMessage> = {
      extractMessage: () => ({ kind: "skip", reason: "test" }),
      sendReply: async () => {},
      async sendBootMessage() {
        throw new Error("telegram api down");
      },
    };

    const result = await runWithBootMessages({
      channel: "telegram",
      adapter,
      message: createMessage(),
      origin: "https://app.test",
      reason: "test",
      timeoutMs: 5_000,
    });

    // Should return gracefully without boot message
    assert.equal(result.bootMessageSent, false);
  });
});

test("boot-messages: updates message on status transition", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("not-ready", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      // Simulate status transitions
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "creating";
      });
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "booting";
        meta.sandboxId = "sbx-1";
      });
      await new Promise((r) => setTimeout(r, 100));
      await mutateMeta((meta) => {
        meta.status = "running";
      });
      globalThis.fetch = (async () => {
        return new Response("openclaw-app", { status: 200 });
      }) as typeof fetch;

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);

      // Should have status update messages
      const updates = log.filter((e) => e.action === "update");
      assert.ok(updates.length >= 1, "should have at least one status update");

      // Check that we see restore-oriented status transitions
      const updateTexts = updates.map((e) => e.text).join("|");
      assert.ok(
        updateTexts.includes("Restoring") || updateTexts.includes("Starting"),
        `should have status transitions in: ${updateTexts}`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("boot-messages: telegram does not short-circuit on port 3000 gateway readiness", async () => {
  await withEnv(TEST_ENV, async () => {
    const fakeController = new FakeSandboxController();
    _setSandboxControllerForTesting(fakeController);

    await mutateMeta((meta) => {
      meta.status = "stopped";
      meta.snapshotId = "snap-1";
    });

    const { adapter, log } = createTrackingAdapter();

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("openclaw-app", { status: 200 });
    }) as typeof fetch;

    try {
      const resultPromise = runWithBootMessages({
        channel: "telegram",
        adapter,
        message: createMessage(),
        origin: "https://app.test",
        reason: "test",
        timeoutMs: 10_000,
        pollIntervalMs: 50,
      });

      await new Promise((r) => setTimeout(r, 150));
      await mutateMeta((meta) => {
        meta.status = "booting";
        meta.sandboxId = "sbx-telegram";
      });

      await new Promise((r) => setTimeout(r, 200));

      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });

      assert.equal(
        settled,
        false,
        "telegram boot flow must keep waiting even when port 3000 probe succeeds",
      );
      assert.equal(fetchCalls, 0, "telegram boot flow must not call probeGatewayReady");

      await mutateMeta((meta) => {
        meta.status = "running";
      });

      const result = await resultPromise;

      assert.equal(result.bootMessageSent, true);
      assert.ok(log.some((e) => e.action === "send"), "should have sent boot message");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
