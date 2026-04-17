import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta, RestorePhaseMetrics } from "@/shared/types";
import { getServerLogs, _resetLogBuffer } from "@/server/log";
import { _resetStoreForTesting, getInitializedMeta } from "@/server/store/store";
import { setTelegramChannelConfig } from "@/server/channels/state";
import {
  processChannelStep,
  toWorkflowProcessingError,
  type DrainChannelWorkflowDependencies,
  type ChannelWorkflowHandoff,
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

function createFallbackTelegramConfig() {
  return {
    botToken: "123456:handoff-token",
    webhookSecret: "handoff-secret",
    webhookUrl: "https://example.test/api/channels/telegram/webhook",
    botUsername: "handoff_bot",
    configuredAt: 1_777_000_000_000,
  };
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
    forwardToNativeHandler: async () => ({
      ok: true,
      status: 200,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
    }),
    forwardTelegramToNativeHandlerLocally: async () => ({
      ok: true,
      status: 200,
      durationMs: 0,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
      error: null,
    }),
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => ({
      ok: true,
      status: 200,
      attempts: 1,
      totalMs: 50,
      transport: "public",
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

const WORKFLOW_TEST_ENV_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "REDIS_URL",
    "KV_URL",
] as const;

let workflowTestEnvOriginals: Record<string, string | undefined> = {};

test.beforeEach(async () => {
  workflowTestEnvOriginals = {};
  for (const key of WORKFLOW_TEST_ENV_KEYS) {
    workflowTestEnvOriginals[key] = process.env[key];
  }
  process.env.NODE_ENV = "test";
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.REDIS_URL;
  delete process.env.KV_URL;
  _resetStoreForTesting();
  _resetLogBuffer();
});

test.afterEach(async () => {
  for (const key of WORKFLOW_TEST_ENV_KEYS) {
    const value = workflowTestEnvOriginals[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, { dependencies });

  assert.equal(ensureCalls, 1);
  assert.equal(forwardedSandboxId, "sbx-restored");
});

test("processChannelStep restores Telegram config from workflow handoff when store is empty", async () => {
  const fallbackTelegramConfig = createFallbackTelegramConfig();
  let bootHandleSawConfig = false;
  let forwardedWebhookSecret: string | null = null;

  const dependencies = createWorkflowDependencies({
    buildExistingBootHandle: async () => {
      const meta = await getInitializedMeta();
      bootHandleSawConfig = meta.channels.telegram?.webhookSecret === fallbackTelegramConfig.webhookSecret;
      return undefined;
    },
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-handoff" }),
      bootMessageSent: false,
    }),
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedWebhookSecret = meta.channels.telegram?.webhookSecret ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 1, message: { chat: { id: 123 } } },
    "test",
    "req-handoff",
    null,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  const meta = await getInitializedMeta();
  assert.ok(bootHandleSawConfig, "boot handle should see restored Telegram config");
  assert.equal(meta.channels.telegram?.webhookSecret, fallbackTelegramConfig.webhookSecret);
  assert.equal(forwardedWebhookSecret, fallbackTelegramConfig.webhookSecret);
});

test("processChannelStep preserves existing Telegram config over workflow handoff fallback", async () => {
  const existingConfig = {
    ...createFallbackTelegramConfig(),
    webhookSecret: "existing-secret",
    botUsername: "existing_bot",
  };
  const fallbackTelegramConfig = createFallbackTelegramConfig();
  let forwardedWebhookSecret: string | null = null;

  await setTelegramChannelConfig(existingConfig);

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-existing",
        channels: {
          telegram: existingConfig as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
    }),
    forwardToNativeHandlerWithRetry: async (_channel: unknown, _payload: unknown, meta: SingleMeta): Promise<RetryingForwardResult> => {
      forwardedWebhookSecret = meta.channels.telegram?.webhookSecret ?? null;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep(
    "telegram",
    { update_id: 2, message: { chat: { id: 456 } } },
    "test",
    "req-existing",
    null,
    {
      dependencies,
      workflowHandoff: {
        fallbackTelegramConfig,
      } satisfies ChannelWorkflowHandoff,
    },
  );

  const meta = await getInitializedMeta();
  assert.equal(meta.channels.telegram?.webhookSecret, existingConfig.webhookSecret);
  assert.equal(forwardedWebhookSecret, existingConfig.webhookSecret);
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
      transport: "public",
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
      transport: "public",
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200, durationMs: 0, bodyLength: 0, bodyHead: "", headers: null };
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
    forwardToNativeHandler: async () => {
      directCalled = true;
      return { ok: true, status: 200, durationMs: 0, bodyLength: 0, bodyHead: "", headers: null };
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
      transport: null,
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
      transport: "public",
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
// Telegram probe skip gate: lastRestoreMetrics.telegramListenerReady
// ===========================================================================

test("processChannelStep skips probe loop when lastRestoreMetrics.telegramListenerReady === true", async () => {
  _resetLogBuffer();

  let localProbeCalls = 0;
  let publicProbeCalls = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-listener-ready",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 1_000,
          localReadyMs: 500,
          telegramListenerReady: true,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: false,
    }),
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCalls += 1;
      return { status: 401, ready: true, error: null };
    },
    waitForTelegramNativeHandler: async (): Promise<TelegramProbeResult> => {
      publicProbeCalls += 1;
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

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-listener-ready", null, {
    dependencies,
  });

  assert.equal(
    localProbeCalls,
    0,
    "probeTelegramNativeHandlerLocally must NOT be called when telegramListenerReady === true",
  );
  assert.equal(
    publicProbeCalls,
    0,
    "waitForTelegramNativeHandler must NOT be called when telegramListenerReady === true",
  );

  // The skip is surfaced on the emitted wake summary so upstream observability can
  // distinguish a trusted-from-restore skip from a natural probe success.
  const logs = getServerLogs();
  const summary = logs.find((e) => e.message === "channels.telegram_wake_summary");
  assert.ok(summary, "telegram_wake_summary must be emitted");
  assert.equal(
    summary!.data?.telegramProbeSkippedReason,
    "local-handler-ready",
    "summary should record skip-reason 'local-handler-ready' when trusted from restore metrics",
  );
});

test("processChannelStep preserves probe behavior when telegramListenerReady !== true", async () => {
  _resetLogBuffer();

  let localProbeCalls = 0;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-listener-unproven",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 1_000,
          localReadyMs: 500,
          telegramListenerReady: false,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: false,
    }),
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCalls += 1;
      return { status: 401, ready: true, error: null };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-listener-unproven", null, {
    dependencies,
  });

  assert.ok(
    localProbeCalls >= 1,
    "probeTelegramNativeHandlerLocally must run at least once when telegramListenerReady !== true",
  );
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
    postLocalReadyBlockingMs: 1600,
    publicReadyMs: 100,
    bootOverlapMs: 50,
    skippedStaticAssetSync: true,
    skippedDynamicConfigSync: true,
    dynamicConfigReason: "hash-match",
    telegramReconcileBlocking: true,
    telegramReconcileMs: 700,
    telegramSecretSyncBlocking: true,
    telegramSecretSyncMs: 350,
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
  assert.equal(data.localReadyMs, 400);
  assert.equal(data.postLocalReadyBlockingMs, 1600);
  assert.equal(data.skippedStaticAssetSync, true);
  assert.equal(data.skippedDynamicConfigSync, true);
  assert.equal(data.dynamicConfigReason, "hash-match");
  assert.equal(data.telegramReconcileBlocking, true);
  assert.equal(data.telegramReconcileMs, 700);
  assert.equal(data.telegramSecretSyncBlocking, true);
  assert.equal(data.telegramSecretSyncMs, 350);
  assert.equal(data.telegramProbeReady, true);
  assert.equal(data.telegramProbeLastStatus, null);
  assert.equal(data.telegramProbePublicUrl, null);
  assert.equal(data.telegramProbeSkippedReason, "local-handler-ready");
  assert.equal(data.telegramLocalProbeStatus, 401);
  assert.equal(data.telegramLocalProbeReady, true);
  assert.equal(data.telegramLocalProbeError, null);
  assert.equal(data.retryingForwardAttempts, 1);
  assert.equal(data.hotSpareHit, false);
  assert.equal(data.hotSparePromotionMs, 0);
  assert.equal(data.hotSpareRejectReason, "feature-disabled");
});

test("processChannelStep logs Telegram probe mismatch when public probe becomes ready after local stall", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-mismatch",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
        lastRestoreMetrics: {
          totalMs: 17_400,
          localReadyMs: 2_000,
          postLocalReadyBlockingMs: 15_400,
          telegramReconcileBlocking: true,
          telegramReconcileMs: 600,
          telegramSecretSyncBlocking: true,
          telegramSecretSyncMs: 250,
        } as RestorePhaseMetrics,
      }),
      bootMessageSent: true,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: "connect ECONNREFUSED",
      detail: "handler-not-bound",
      durationMs: 35,
      bodyLength: 0,
      bodyHead: "",
      headers: null,
    }),
    waitForTelegramNativeHandler: async () => ({
      ready: true,
      attempts: 20,
      waitMs: 15_000,
      lastStatus: 401,
      publicUrl: "https://tg.test",
      timeline: [{ attempt: 20, elapsedMs: 15_000, status: 401 }],
    }),
    forwardToNativeHandlerWithRetry: async () => ({
      ok: true,
      status: 200,
      attempts: 2,
      totalMs: 120,
      transport: "public",
      retries: [{ attempt: 1, reason: "proxy-error", status: 502 }],
    }),
  });

  await processChannelStep("telegram", { update_id: 99 }, "test", "req-mismatch", null, {
    dependencies,
  });

  const logs = getServerLogs();
  const mismatchLog = logs.find((entry) => entry.message === "channels.telegram_probe_local_mismatch");
  assert.ok(mismatchLog, "mismatch log should be emitted when public probe succeeds after local stall");
  assert.equal(mismatchLog.data?.sandboxId, "sbx-mismatch");
  assert.equal(mismatchLog.data?.publicWaitMs, 15_000);
  assert.equal(mismatchLog.data?.localStatus, 404);
  assert.equal(mismatchLog.data?.localReady, false);
  assert.equal(mismatchLog.data?.localError, "connect ECONNREFUSED");
  assert.equal(mismatchLog.data?.localDetail, "handler-not-bound");

  const summaryLog = logs.find((entry) => entry.message === "channels.telegram_wake_summary");
  assert.ok(summaryLog, "telegram wake summary should be emitted");
  assert.equal(summaryLog.data?.telegramProbeReady, true);
  assert.equal(summaryLog.data?.telegramProbeLastStatus, 401);
  assert.equal(summaryLog.data?.telegramProbeSkippedReason, null);
  assert.equal(summaryLog.data?.telegramLocalProbeStatus, 404);
  assert.equal(summaryLog.data?.telegramLocalProbeReady, false);
  assert.equal(summaryLog.data?.telegramLocalProbeError, "connect ECONNREFUSED");
  assert.equal(summaryLog.data?.telegramLocalProbeDetail, "handler-not-bound");
  assert.equal(summaryLog.data?.postLocalReadyBlockingMs, 15_400);
  assert.equal(summaryLog.data?.telegramReconcileBlocking, true);
  assert.equal(summaryLog.data?.telegramSecretSyncBlocking, true);
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
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

test("processChannelStep uses local Telegram native handler readiness before forwarding", async () => {
  let probeCallCount = 0;
  let forwardCalledAfterLocalProbe = false;
  let localProbeCallCount = 0;

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
    probeTelegramNativeHandlerLocally: async () => {
      localProbeCallCount += 1;
      return {
        status: 401,
        ready: true,
        error: null,
      };
    },
    forwardToNativeHandlerWithRetry: async (): Promise<RetryingForwardResult> => {
      forwardCalledAfterLocalProbe = localProbeCallCount > 0;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "local", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe", null, { dependencies });

  assert.equal(localProbeCallCount, 1, "local probe should be called exactly once for Telegram");
  assert.equal(probeCallCount, 0, "public probe should be skipped when local handler is ready");
  assert.ok(forwardCalledAfterLocalProbe, "forward should only happen after local probe completes");
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

test("processChannelStep falls back to public Telegram probe when local handler is not ready", async () => {
  let probeCallCount = 0;
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
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: null,
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
      forwardCalled = true;
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe-timeout", null, { dependencies });

  assert.equal(probeCallCount, 1, "public probe should run when local handler is not ready");
  assert.ok(forwardCalled, "forward should still be attempted after public probe fallback");
});

test("processChannelStep still forwards when both Telegram probes time out", async () => {
  // If both probes time out, we should still attempt the forward (best effort).
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
    probeTelegramNativeHandlerLocally: async () => ({
      status: 404,
      ready: false,
      error: "connect ECONNREFUSED",
    }),
    waitForTelegramNativeHandler: async () => {
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
      return { ok: true, status: 200, attempts: 1, totalMs: 50, transport: "public", retries: [] };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-probe-timeout", null, { dependencies });

  assert.ok(forwardCalled, "forward should still be attempted even after both probes time out");
});

test("processChannelStep accepts local Telegram empty 200 without retrying", async () => {
  _resetLogBuffer();

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({
        status: "running",
        sandboxId: "sbx-local-200",
        portUrls: { "3000": "https://gw.test", "8787": "https://tg.test" },
        channels: {
          telegram: { botToken: "tok", webhookSecret: "secret" } as never,
          slack: null,
          discord: null,
          whatsapp: null,
        },
      }),
      bootMessageSent: false,
    }),
    probeTelegramNativeHandlerLocally: async () => ({
      status: 401,
      ready: true,
      error: null,
      durationMs: 40,
      bodyLength: 12,
      bodyHead: "unauthorized",
      headers: null,
    }),
    forwardToNativeHandlerWithRetry: async () => ({
      ok: true,
      status: 200,
      attempts: 1,
      totalMs: 42,
      transport: "local",
      retries: [],
      attemptsDetail: [
        {
          attempt: 1,
          startedAtMs: Date.now(),
          elapsedMs: 42,
          durationMs: 42,
          status: 200,
          ok: true,
          bodyLength: 0,
          bodyHead: "",
          headers: {
            server: null,
            contentType: "text/plain; charset=utf-8",
            contentLength: null,
            xPoweredBy: null,
            via: null,
            cacheControl: null,
          },
          transport: "local",
          classification: "accepted",
        },
      ],
    }),
    forwardTelegramToNativeHandlerLocally: async () => {
      return {
        ok: true,
        status: 200,
        durationMs: 42,
        bodyLength: 0,
        bodyHead: "",
        headers: {
          server: null,
          contentType: "text/plain; charset=utf-8",
          contentLength: null,
          xPoweredBy: null,
          via: null,
          cacheControl: null,
        },
        error: null,
      };
    },
  });

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-local-200", null, {
    dependencies,
  });

  const logs = getServerLogs();
  const summary = logs.find((entry) => entry.message === "channels.telegram_wake_summary");
  assert.ok(summary, "telegram wake summary should be emitted");
  assert.equal(summary.data?.retryingForwardAttempts, 1);
  assert.equal(summary.data?.retryingForwardTransport, "local");
  const attemptTimeline = summary.data?.retryingForwardAttemptTimeline as
    | Array<{ classification?: string }>
    | undefined;
  assert.equal(
    attemptTimeline?.[0]?.classification,
    "accepted",
  );
});
