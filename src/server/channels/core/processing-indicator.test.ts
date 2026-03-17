// src/server/channels/core/processing-indicator.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  startDelayed,
  startKeepAlive,
  startPlatformProcessingIndicator,
} from "@/server/channels/core/processing-indicator";
import type { PlatformAdapter } from "@/server/channels/core/types";

test("startKeepAlive pulses immediately, repeats, and stops cleanly", async () => {
  let calls = 0;
  const indicator = startKeepAlive(async () => {
    calls += 1;
  }, 20);

  await delay(5);
  assert.equal(calls >= 1, true);

  await delay(50);
  const beforeStop = calls;
  assert.equal(beforeStop >= 3, true);

  await indicator.stop();
  await delay(40);

  assert.equal(calls, beforeStop);
});

test("startKeepAlive swallows errors thrown by the pulse callback", async () => {
  let calls = 0;
  const indicator = startKeepAlive(async () => {
    calls += 1;
    throw new Error("pulse error");
  }, 20);

  await delay(50);
  assert.equal(calls >= 2, true);
  await indicator.stop();
});

test("startKeepAlive stop is idempotent", async () => {
  const indicator = startKeepAlive(async () => {}, 20);
  await indicator.stop();
  await indicator.stop();
});

test("startDelayed cancels before start", async () => {
  let started = 0;
  const indicator = startDelayed(async () => {
    started += 1;
    return { async stop() {} };
  }, 30);

  await delay(10);
  await indicator.stop();
  await delay(40);

  assert.equal(started, 0);
});

test("startDelayed starts after delay", async () => {
  let started = 0;
  const indicator = startDelayed(async () => {
    started += 1;
    return { async stop() {} };
  }, 10);

  await delay(30);
  assert.equal(started, 1);
  await indicator.stop();
});

test("startDelayed stop is idempotent", async () => {
  const indicator = startDelayed(async () => {
    return { async stop() {} };
  }, 0);

  await indicator.stop();
  await indicator.stop();
});

test("startDelayed stops an indicator that resolves after stop is requested", async () => {
  let stopCalls = 0;

  const indicator = startDelayed(
    async () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            async stop() {
              stopCalls += 1;
            },
          });
        }, 20);
      }),
    0,
  );

  await indicator.stop();
  await delay(40);

  assert.equal(stopCalls, 1);
});

test("startDelayed with zero delay starts immediately", async () => {
  let started = 0;
  const indicator = startDelayed(async () => {
    started += 1;
    return { async stop() {} };
  }, 0);

  await delay(10);
  assert.equal(started, 1);
  await indicator.stop();
});

test("startPlatformProcessingIndicator prefers startProcessingIndicator over legacy typing", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async startProcessingIndicator() {
      calls.push("start");
      return {
        async stop() {
          calls.push("stop");
        },
      };
    },
    async sendTypingIndicator() {
      calls.push("legacy-start");
    },
    async clearTypingIndicator() {
      calls.push("legacy-stop");
    },
  };

  const indicator = await startPlatformProcessingIndicator(
    adapter,
    { text: "hello" },
    { delayMs: 0 },
  );

  // Wait for the delayed start to resolve
  await delay(10);
  assert.deepEqual(calls, ["start"]);
  await indicator.stop();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("startPlatformProcessingIndicator falls back to sendTypingIndicator when startProcessingIndicator is absent", async () => {
  const calls: string[] = [];
  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async sendTypingIndicator() {
      calls.push("legacy-start");
    },
    async clearTypingIndicator() {
      calls.push("legacy-stop");
    },
  };

  const indicator = await startPlatformProcessingIndicator(
    adapter,
    { text: "hello" },
    { delayMs: 0 },
  );

  assert.deepEqual(calls, ["legacy-start"]);
  await indicator.stop();
  assert.deepEqual(calls, ["legacy-start", "legacy-stop"]);
});

test("startPlatformProcessingIndicator returns noop when adapter has no typing methods", async () => {
  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
  };

  const indicator = await startPlatformProcessingIndicator(
    adapter,
    { text: "hello" },
    { delayMs: 0 },
  );

  // Should not throw
  await indicator.stop();
  await indicator.stop();
});

test("startPlatformProcessingIndicator calls onError when sendTypingIndicator fails", async () => {
  const errors: unknown[] = [];
  const adapter: PlatformAdapter<unknown, { text: string }> = {
    extractMessage() {
      throw new Error("not used");
    },
    async sendReply() {},
    async sendTypingIndicator() {
      throw new Error("typing failed");
    },
  };

  const indicator = await startPlatformProcessingIndicator(
    adapter,
    { text: "hello" },
    {
      delayMs: 0,
      onError: (err) => errors.push(err),
    },
  );

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "typing failed");
  // Should still return a noop indicator that doesn't throw
  await indicator.stop();
});
