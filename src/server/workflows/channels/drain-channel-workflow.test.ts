import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta } from "@/shared/types";
import {
  processChannelStep,
  toWorkflowProcessingError,
  type DrainChannelWorkflowDependencies,
  type RetryingForwardResult,
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
    processChannelJob: async () => {
      throw new Error("not implemented in test");
    },
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
    buildExistingBootHandle: async () => undefined,
    RetryableError: TestRetryableError as never,
    FatalError: TestFatalError as never,
    ...overrides,
  };
}

test("processChannelStep always ensures sandbox readiness before native forward", async () => {
  let ensureCalls = 0;
  let forwardedSandboxId: string | null = null;

  const dependencies = createWorkflowDependencies({
    runWithBootMessages: async () => ({
      meta: asMeta({ status: "running", sandboxId: "sbx-stale" }),
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

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies);

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
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies),
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
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies),
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
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies),
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

  await processChannelStep("telegram", { update_id: 1 }, "test", "req-tg", null, telegramDeps);
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

  await processChannelStep("slack", { event: {} }, "test", "req-slack", null, slackDeps);
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
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies),
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
    processChannelStep("telegram", { update_id: 1 }, "test", "req-1", null, dependencies),
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
