import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta, RestorePhaseMetrics } from "@/shared/types";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import {
  processChannelStep,
  toWorkflowProcessingError,
  type DrainChannelWorkflowDependencies,
  type RetryingForwardResult,
  type TelegramProbeResult,
} from "@/server/workflows/channels/drain-channel-workflow";

class TestRetryableError extends Error {
  retryAfter?: string;

  constructor(message: string, options?: { retryAfter?: string }) {
    super(message);
    this.name = "RetryableError";
    this.retryAfter = options?.retryAfter;
  }

  static is(err: unknown): err is TestRetryableError {
    return err instanceof TestRetryableError;
  }
}

class TestFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }

  static is(err: unknown): err is TestFatalError {
    return err instanceof TestFatalError;
  }
}

function asMeta(meta: Partial<SingleMeta>): SingleMeta {
  return meta as SingleMeta;
}

function createWorkflowDependencies(
  overrides: Partial<DrainChannelWorkflowDependencies> = {},
): DrainChannelWorkflowDependencies {
  return {
    isRetryable: () => false,
    createSlackAdapter: () => ({}) as never,
    createTelegramAdapter: () => ({}) as never,
    createDiscordAdapter: () => ({}) as never,
    createWhatsAppAdapter: () => ({}) as never,
    reconcileDiscordIntegration: async () => null,
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-stale" }),
      bootMessageSent: false,
    }),
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
    getSandboxDomain: async () => "https://sandbox.example.test",
    forwardToNativeHandler: async () => ({ ok: true, status: 200 }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      status: 200,
      attempts: 1,
      totalMs: 50,
      retries: [],
    }),
    waitForTelegramNativeHandler: async (): Promise<TelegramProbeResult> => ({
      ready: true,
      attempts: 1,
      waitMs: 0,
      lastStatus: 401,
      publicUrl: "https://sandbox.example.test",
      timeline: [{ attempt: 1, elapsedMs: 0, status: 401 }],
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 401,
      ready: true,
      error: null,
    }),
    buildExistingBootHandle: async () => undefined,
    RetryableError: TestRetryableError as never,
    FatalError: TestFatalError as never,
    ...overrides,
  };
}

test("processChannelStep skips ensureSandboxReady when boot returns running", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-booted" }),
      bootMessageSent: false,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      });
    },
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies });

  // When boot returns running, ensureSandboxReady is skipped to avoid
  // the redundant public gateway probe that times out in workflow steps.
  assert.equal(ensureCalls, 0);
  assert.equal(forwardedSandboxId, "sbx-booted");
});

test("processChannelStep falls back to ensureSandboxReady when boot returns non-running", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "booting", sandboxId: "sbx-stale" }),
      bootMessageSent: true,
    }),
    ensureSandboxReady: async () => {
      ensureCalls += 1;
      return asMeta({
        status: "running",
        sandboxId: "sbx-restored",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      });
    },
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedSandboxId = meta.sandboxId ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies });

  assert.equal(ensureCalls, 1);
  assert.equal(forwardedSandboxId, "sbx-restored");
});

test("processChannelStep converts retrying forward fetch exception into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async () => {
      throw new Error("native_handler_timeout channel=telegram timeoutMs=30000");
    },
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep converts native forward 502 into RetryableError (Telegram retrying path)", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 502,
      attempts: 6,
      totalMs: 6000,
      retries: [{ attempt: 1, reason: "proxy-error", status: 502 }],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep keeps native forward 404 fatal (Telegram retrying path)", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 404,
      attempts: 1,
      totalMs: 50,
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestFatalError);
      return true;
    },
  );
});

test("processChannelStep uses retrying forward for Telegram, direct forward for Slack", async () => {
  let retryingCalled = false;
  let directCalled = false;

  const telegramDeps = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      retryingCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200 };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-tg", null, { dependencies: telegramDeps });
  assert.ok(retryingCalled, "Telegram should use retrying forward");
  assert.ok(!directCalled, "Telegram should not use direct forward");

  retryingCalled = false;
  directCalled = false;

  const slackDeps = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      retryingCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200 };
    },
  });

  await processChannelStep("slack", { event: {} }, "test", "req-slack", null, { dependencies: slackDeps });
  assert.ok(!retryingCalled, "Slack should not use retrying forward");
  assert.ok(directCalled, "Slack should use direct forward");
});

test("processChannelStep converts retrying forward 504 (exhausted) into RetryableError", async () => {
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 504,
      attempts: 6,
      totalMs: 30000,
      retries: [
        { attempt: 1, reason: "proxy-error", status: 503 },
        { attempt: 2, reason: "fetch-exception", error: "connect ECONNREFUSED" },
      ],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("processChannelStep treats retrying forward 500 as retryable at workflow level", async () => {
  // A 500 from the handler is NOT retried within the forward loop (handler processed
  // the request), but is still retryable at the workflow step level since the
  // existing error mapper treats native_forward_failed >= 500 as transient.
  const dependencies = createWorkflowDependencies({
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: false,
      status: 500,
      attempts: 1,
      totalMs: 100,
      retries: [],
    }),
  });

  await assert.rejects(
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies }),
    (error: unknown) => {
      assert.ok(error instanceof TestRetryableError);
      assert.equal((error as TestRetryableError).retryAfter, "15s");
      return true;
    },
  );
});

test("toWorkflowProcessingError returns RetryableError for sandbox_not_ready", () => {
  const error = toWorkflowProcessingError(
    "slack",
    new Error("sandbox_not_ready: gateway probe still loading"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for SANDBOX_READY_TIMEOUT", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("SANDBOX_READY_TIMEOUT: sandbox did not become ready in time"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for native_handler_timeout", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_handler_timeout channel=telegram timeoutMs=30000"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns RetryableError for native_forward_failed 503", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_forward_failed status=503"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestRetryableError);
  assert.equal((error as TestRetryableError).retryAfter, "15s");
});

test("toWorkflowProcessingError returns FatalError for native_forward_failed 404", () => {
  const error = toWorkflowProcessingError(
    "telegram",
    new Error("native_forward_failed status=404"),
    createWorkflowDependencies(),
  );

  assert.ok(error instanceof TestFatalError);
});

// ===========================================================================
// Telegram wake summary log
// ===========================================================================

test("processChannelStep emits channels.telegram_wake_summary for Telegram requests", async () => {
  _resetLogBuffer();

  const fakeRestoreMetrics: Partial<RestorePhaseMetrics> = {
    totalMs: 2000,
    sandboxCreateMs: 900,
    assetSyncMs: 0,
    startupScriptMs: 600,
    localReadyMs: 400,
    publicReadyMs: 100,
    bootOverlapMs: 50,
    skippedStaticAssetSync: true,
    skippedDynamicConfigSync: true,
    dynamicConfigReason: "hash-match",
    hotSpareHit: false,
    hotSparePromotionMs: 0,
    hotSpareRejectReason: "feature-disabled",
  };

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-wake-summary",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
        lastRestoreMetrics: fakeRestoreMetrics as RestorePhaseMetrics,
      }),
      bootMessageSent: true,
    }),
  });

  const receivedAtMs = Date.now() - 50;
  await processChannelStep("telegram", { update_id: 1 }, "test", "req-wake", null, {
    receivedAtMs,
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1, "exactly one telegram_wake_summary log expected");

  const data = summaryLogs[0].data ?? {};
  assert.equal(data.channel, "telegram");
  assert.equal(data.requestId, "req-wake");
  assert.equal(data.sandboxId, "sbx-wake-summary");
  assert.equal(typeof data.endToEndMs, "number");
  assert.ok((data.endToEndMs as number) >= 0);
  assert.equal(data.restoreTotalMs, 2000);
  assert.equal(data.startupScriptMs, 600);
  assert.equal(data.skippedStaticAssetSync, true);
  assert.equal(data.skippedDynamicConfigSync, true);
  assert.equal(data.dynamicConfigReason, "hash-match");
  assert.equal(data.telegramProbeReady, true);
  assert.equal(data.telegramProbeLastStatus, 401);
  assert.equal(data.telegramProbePublicUrl, "https://sandbox.example.test");
  assert.equal(data.telegramLocalProbeStatus, 401);
  assert.equal(data.telegramLocalProbeReady, true);
  assert.equal(data.telegramLocalProbeError, null);
  assert.equal(data.retryingForwardAttempts, 1);
  assert.equal(data.hotSpareHit, false);
  assert.equal(data.hotSparePromotionMs, 0);
  assert.equal(data.hotSpareRejectReason, "feature-disabled");
});

test("processChannelStep does NOT emit telegram_wake_summary for Slack requests", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies();

  await processChannelStep("slack", { event: {} }, "test", "req-slack-no-summary", null, { dependencies });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 0, "no telegram_wake_summary log for Slack channel");
});

test("processChannelStep includes webhookToWorkflowMs when receivedAtMs is provided", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-timing",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
  });

  const receivedAtMs = Date.now() - 100;
  await processChannelStep("telegram", { update_id: 2 }, "test", "req-timing", null, {
    receivedAtMs,
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1);

  const data = summaryLogs[0].data ?? {};
  assert.equal(typeof data.webhookToWorkflowMs, "number");
  assert.ok((data.webhookToWorkflowMs as number) >= 0);
  assert.equal(typeof data.workflowToSandboxReadyMs, "number");
  assert.equal(typeof data.forwardMs, "number");
});

test("processChannelStep sets webhookToWorkflowMs to null when receivedAtMs is not provided", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    ensureSandboxReady: async () =>
      asMeta({
        status: "running",
        sandboxId: "sbx-no-received",
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
  });

  await processChannelStep("telegram", { update_id: 3 }, "test", "req-no-ts", null, {
    dependencies,
  });

  const logs = getServerLogs();
  const summaryLogs = logs.filter((e) => e.message === "channels.telegram_wake_summary");
  assert.equal(summaryLogs.length, 1);

  const data = summaryLogs[0].data ?? {};
  assert.equal(data.webhookToWorkflowMs, null);
  assert.equal(data.endToEndMs, null);
});

test("processChannelStep forward captures Telegram webhook secret and correct port domain", async () => {
  _resetLogBuffer();

  let capturedChannel: string | null = null;
  let capturedPayload: unknown = null;
  let capturedMeta: SingleMeta | null = null;
  let capturedGetSandboxDomain: ((port?: number) => Promise<string>) | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-tg-forward",
        portUrls: { "3000": "https://sbx.example.test", "8787": "https://sbx-8787.example.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret-123" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
    }),
    forwardToNativeHandlerWithRetry: async (
      channel: unknown,
      payload: unknown,
      meta: SingleMeta,
      getSandboxDomain: (port?: number) => Promise<string>,
    ): Promise<RetryingForwardResult> => {
      capturedChannel = channel as string;
      capturedPayload = payload;
      capturedMeta = meta;
      capturedGetSandboxDomain = getSandboxDomain;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  const telegramUpdate = { update_id: 999, message: { chat: { id: 12345 }, text: "hello" } };
  await processChannelStep("telegram", telegramUpdate, "test", "req-forward", null, { dependencies });

  // Verify the forward received the right data
  assert.equal(capturedChannel, "telegram");
  assert.deepStrictEqual(capturedPayload, telegramUpdate);
  assert.ok(capturedMeta, "meta should be captured");
  const meta = capturedMeta as SingleMeta;
  assert.equal(meta.sandboxId, "sbx-tg-forward");
  assert.equal(meta.channels.telegram?.webhookSecret, "secret-123");
  assert.ok(meta.portUrls?.["8787"], "portUrls should include port 8787");
  assert.ok(capturedGetSandboxDomain, "getSandboxDomain should be passed");
});

test("processChannelStep forward passes meta with portUrls from boot result", async () => {
  // Simulates the scenario where runWithBootMessages returns running meta
  // and the forward needs portUrls to resolve the sandbox domain.
  let forwardedPortUrls: Record<string, string> | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-ports",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: { telegram: null, slack: null, discord: null, whatsapp: null },
      }),
      bootMessageSent: false,
    }),
    forwardToNativeHandlerWithRetry: async (
      _channel: unknown,
      _payload: unknown,
      meta: SingleMeta,
    ): Promise<RetryingForwardResult> => {
      forwardedPortUrls = (meta.portUrls as Record<string, string>) ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-ports", null, { dependencies });

  assert.ok(forwardedPortUrls, "portUrls should be present in forwarded meta");
  assert.equal(forwardedPortUrls["3000"], "https://gw.test");
  assert.equal(forwardedPortUrls["8787"], "https://tg.test");
});

// ---------------------------------------------------------------------------
// Telegram native handler readiness probe tests
// ---------------------------------------------------------------------------

test("processChannelStep waits for Telegram native handler before forwarding", async () => {
  // Simulates the scenario where the base server on port 8787 returns 200
  // (swallowing the payload) until the Telegram handler registers and
  // starts returning 401.
  let probeCallCount = 0;
  let forwardCalledAfterProbe = false;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-probe-test",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
    }),
    waitForTelegramNativeHandler: async () => {
      probeCallCount += 1;
      return {
        ready: true,
        attempts: 5,
        waitMs: 2500,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 5, elapsedMs: 2500, status: 401 }],
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalledAfterProbe = probeCallCount > 0;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe", null, { dependencies });

  assert.equal(probeCallCount, 1, "probe should be called exactly once for Telegram");
  assert.ok(forwardCalledAfterProbe, "forward should only happen after probe completes");
});

test("processChannelStep does NOT probe for non-Telegram channels", async () => {
  let probeCallCount = 0;

  const dependencies = createWorkflowDependencies({
    waitForTelegramNativeHandler: async () => {
      probeCallCount += 1;
      return {
        ready: true,
        attempts: 1,
        waitMs: 0,
        lastStatus: 401,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 1, elapsedMs: 0, status: 401 }],
      };
    },
  });

  await processChannelStep("slack", { event: {} }, "test", "req-no-probe", null, { dependencies });

  assert.equal(probeCallCount, 0, "probe should NOT be called for Slack");
});

test("processChannelStep still forwards when Telegram probe times out", async () => {
  // If the probe times out, we should still attempt the forward (best effort).
  let forwardCalled = false;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-probe-timeout",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: true,
    }),
    waitForTelegramNativeHandler: async () => {
      // Probe timed out — handler never became ready
      return {
        ready: false,
        attempts: 20,
        waitMs: 15000,
        lastStatus: 404,
        publicUrl: "https://tg.test",
        timeline: [{ attempt: 20, elapsedMs: 15000, status: 404 }],
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe-timeout", null, { dependencies });

  assert.ok(forwardCalled, "forward should still be attempted even after probe timeout");
});
