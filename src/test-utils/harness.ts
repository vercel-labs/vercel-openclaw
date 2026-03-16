/**
 * Scenario test harness for vercel-openclaw integration tests.
 *
 * `createScenarioHarness()` initializes a memory store, resets
 * module-level singletons, installs a FakeSandboxController, and
 * returns a handle with accessors and a teardown function.
 *
 * Compatible with `node:test` via `npm test`.
 */

import assert from "node:assert/strict";

import type { SingleMeta, LogSource } from "@/shared/types";
import type { AuthMode } from "@/server/env";
import type { ChannelName } from "@/shared/channels";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import {
  _resetStoreForTesting,
  getInitializedMeta,
  getStore,
  mutateMeta,
} from "@/server/store/store";
import {
  createFakeFetch,
  chatCompletionsResponse,
  gatewayReadyResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
  type FakeFetch,
  type CapturedRequest,
} from "@/test-utils/fake-fetch";
import {
  SIGN_IN_ENV,
  ADMIN_SECRET_ENV,
} from "@/test-utils/auth-fixtures";
import { resetAfterCallbacks } from "@/test-utils/route-caller";
import {
  FakeSandboxController,
  type SandboxEvent,
  type SandboxEventKind,
} from "@/test-utils/fake-sandbox-controller";
import {
  ensureSandboxRunning,
  stopSandbox,
  probeGatewayReady,
} from "@/server/sandbox/lifecycle";
import { generateDiscordKeyPair } from "@/test-utils/webhook-builders";
import {
  channelQueueKey,
  channelProcessingKey,
} from "@/server/channels/keys";

// Re-export types so existing consumers can keep importing from harness
export type { SandboxEvent, SandboxEventKind } from "@/test-utils/fake-sandbox-controller";
export {
  FakeSandboxController,
  FakeSandboxHandle,
  type CommandResponder,
} from "@/test-utils/fake-sandbox-controller";

// ---------------------------------------------------------------------------
// Log collector
// ---------------------------------------------------------------------------

export type LogEntry = {
  id: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  source: LogSource;
  message: string;
  data?: unknown;
};

export type LogCollector = {
  entries: LogEntry[];
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  clear(): void;
};

let _logCollectorIdCounter = 0;

function createLogCollector(): LogCollector {
  const entries: LogEntry[] = [];

  function push(level: LogEntry["level"], message: string, data?: unknown) {
    _logCollectorIdCounter += 1;
    entries.push({
      id: `tlog-${Date.now()}-${_logCollectorIdCounter}`,
      timestamp: Date.now(),
      level,
      source: "system",
      message,
      data,
    });
  }

  return {
    entries,
    info: (m, d) => push("info", m, d),
    warn: (m, d) => push("warn", m, d),
    error: (m, d) => push("error", m, d),
    debug: (m, d) => push("debug", m, d),
    clear() {
      entries.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Environment overrides
// ---------------------------------------------------------------------------

const ENV_OVERRIDES: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  KV_REST_API_URL: undefined,
  KV_REST_API_TOKEN: undefined,
  // Prevent OIDC token fetching during tests
  AI_GATEWAY_API_KEY: "test-ai-gateway-key",
};

// ---------------------------------------------------------------------------
// Harness types
// ---------------------------------------------------------------------------

/** Snapshot of harness state for test assertions. */
export type StateSnapshot = {
  meta: SingleMeta;
  events: SandboxEvent[];
  sandboxIds: string[];
};

export type ScenarioHarness = {
  /** The fake sandbox controller installed for this scenario. */
  controller: FakeSandboxController;

  /** The configurable fetch mock. */
  fakeFetch: FakeFetch;

  /** Structured log collector for test observability. */
  log: LogCollector;

  /** Shortcut: read the current meta state. */
  getMeta: () => Promise<SingleMeta>;

  /** Shortcut: mutate meta. */
  mutateMeta: typeof mutateMeta;

  /** Shortcut: get the memory store. */
  getStore: typeof getStore;

  /**
   * Capture a snapshot of the current metadata and controller state.
   * Useful for before/after comparisons in assertions.
   */
  captureState: () => Promise<StateSnapshot>;

  /** Clean up: restore env, reset singletons, clear after callbacks. */
  teardown: () => void;

  // -- Observability formatters ------------------------------------------

  /**
   * Format the full timeline: controller events interleaved with
   * HTTP request captures, sorted by timestamp.
   */
  formatTimeline(): string;

  /**
   * Format current queue depths for all channels.
   */
  formatQueues(): Promise<string>;

  /**
   * Format the last N captured HTTP requests (default 10).
   */
  formatLastRequests(n?: number): string;

  /**
   * Format the last N log entries (default 30).
   */
  formatRecentLogs(n?: number): string;

  // -- Shared scenario helpers -------------------------------------------

  /**
   * Drive the sandbox from current state to `running`.
   * Installs a gateway-ready handler, triggers ensureSandboxRunning,
   * executes the scheduled background callback, and probes gateway readiness.
   */
  driveToRunning(): Promise<void>;

  /**
   * Stop the sandbox, producing a snapshot. Asserts status=stopped and
   * snapshotId is present. Returns the snapshotId.
   */
  stopToSnapshot(): Promise<string>;

  /**
   * Configure all three channels (Slack, Telegram, Discord) with test
   * credentials. Returns the signing secrets needed for webhook builders.
   */
  configureAllChannels(): {
    slackSigningSecret: string;
    telegramWebhookSecret: string;
    discordPublicKeyHex: string;
    discordPrivateKey: import("node:crypto").KeyObject;
  };

  /**
   * Register default fetch handlers for gateway completions, all platform
   * APIs, gateway readiness, and Slack thread history.
   * @param gatewayReply Text for the gateway assistant reply.
   */
  installDefaultGatewayHandlers(gatewayReply?: string): void;
};

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

/**
 * Create a scenario test harness.
 *
 * Call this at the start of each test (inside `test()` or a `beforeEach`).
 * Call `harness.teardown()` in the corresponding cleanup / `afterEach`.
 *
 * @example
 * ```ts
 * import test from "node:test";
 * import { createScenarioHarness } from "@/test-utils/harness";
 *
 * test("lifecycle happy path", async () => {
 *   const h = createScenarioHarness();
 *   try {
 *     const meta = await h.getMeta();
 *     assert.equal(meta.status, "uninitialized");
 *   } finally {
 *     h.teardown();
 *   }
 * });
 * ```
 */
export function createScenarioHarness(options?: {
  /** Delay (ms) for fake sandbox create/get operations. */
  controllerDelay?: number;
  /**
   * Auth mode to configure for this scenario.
   *
   * - `'admin-secret'` (default) — clears OAuth env vars
   * - `'sign-in-with-vercel'` — sets SESSION_SECRET, OAuth client vars
   * - `'none'` — does not touch auth env vars at all
   */
  authMode?: AuthMode | "none";
}): ScenarioHarness {
  // Build auth-specific env overrides
  const authOverrides: Record<string, string | undefined> =
    options?.authMode === "sign-in-with-vercel"
      ? SIGN_IN_ENV
      : options?.authMode === "none"
        ? {}
        : ADMIN_SECRET_ENV;

  const mergedOverrides = { ...ENV_OVERRIDES, ...authOverrides };

  // Save original env values
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(mergedOverrides)) {
    originals[key] = process.env[key];
    if (mergedOverrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = mergedOverrides[key];
    }
  }

  // Reset module singletons so tests get a fresh memory store
  _resetStoreForTesting();

  // Install fake sandbox controller
  const controller = new FakeSandboxController({
    delay: options?.controllerDelay,
  });
  _setSandboxControllerForTesting(controller);

  // Create a fake fetch for gateway probes and upstream calls
  const fakeFetch = createFakeFetch();

  // Log collector
  const log = createLogCollector();

  // Clear any pending after callbacks from previous tests
  resetAfterCallbacks();

  // Discord key pair — lazily created on first configureAllChannels call
  let discordKeys: ReturnType<typeof generateDiscordKeyPair> | null = null;

  let tornDown = false;

  const harness: ScenarioHarness = {
    controller,
    fakeFetch,
    log,

    getMeta: getInitializedMeta,
    mutateMeta,
    getStore,

    async captureState(): Promise<StateSnapshot> {
      const meta = await getInitializedMeta();
      return {
        meta,
        events: [...controller.events],
        sandboxIds: controller.created.map((h) => h.sandboxId),
      };
    },

    teardown() {
      if (tornDown) {
        return;
      }
      tornDown = true;

      // Restore sandbox controller
      _setSandboxControllerForTesting(null);

      // Reset store singleton
      _resetStoreForTesting();

      // Clear after callbacks
      resetAfterCallbacks();

      // Restore env
      for (const key of Object.keys(originals)) {
        if (originals[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originals[key];
        }
      }
    },

    // -- Observability formatters ----------------------------------------

    formatTimeline(): string {
      type TimelineEntry = { ts: number; kind: string; detail: string };
      const entries: TimelineEntry[] = [];

      // Controller events
      for (const ev of controller.events) {
        entries.push({
          ts: ev.timestamp,
          kind: `sandbox:${ev.kind}`,
          detail: ev.detail ? JSON.stringify(ev.detail) : ev.sandboxId,
        });
      }

      // HTTP requests
      for (const req of fakeFetch.requests()) {
        entries.push({
          ts: 0, // requests don't have timestamps; sort last per-kind
          kind: `http:${req.method}`,
          detail: req.url,
        });
      }

      // Log entries
      for (const entry of log.entries) {
        entries.push({
          ts: entry.timestamp,
          kind: `log:${entry.level}`,
          detail: entry.message,
        });
      }

      entries.sort((a, b) => a.ts - b.ts);

      const lines = entries.map(
        (e) =>
          `[${e.ts > 0 ? new Date(e.ts).toISOString() : "---"}] ${e.kind}: ${e.detail}`,
      );
      return lines.join("\n");
    },

    async formatQueues(): Promise<string> {
      const store = getStore();
      const channels: ChannelName[] = ["slack", "telegram", "discord"];
      const lines: string[] = [];
      for (const ch of channels) {
        const q = await store.getQueueLength(channelQueueKey(ch));
        const p = await store.getQueueLength(channelProcessingKey(ch));
        lines.push(`${ch}: queue=${q} processing=${p}`);
      }
      return lines.join("\n");
    },

    formatLastRequests(n = 10): string {
      const reqs = fakeFetch.requests();
      const slice = reqs.slice(-n);
      return slice
        .map(
          (r) =>
            `${r.method} ${r.url}${r.headers?.["Authorization"] ? " [auth]" : ""}`,
        )
        .join("\n");
    },

    formatRecentLogs(n = 30): string {
      const slice = log.entries.slice(-n);
      return slice
        .map(
          (e) =>
            `[${e.level}] ${e.message}${e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ""}`,
        )
        .join("\n");
    },

    // -- Shared scenario helpers -----------------------------------------

    async driveToRunning(): Promise<void> {
      fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch.fetch;

      try {
        let scheduledCallback: (() => Promise<void> | void) | null = null;

        const result = await ensureSandboxRunning({
          origin: "https://test.example.com",
          reason: "harness-driveToRunning",
          schedule(cb) {
            scheduledCallback = cb;
          },
        });

        if (result.state === "waiting") {
          assert.ok(
            scheduledCallback,
            "Background work should have been scheduled",
          );
          await (scheduledCallback as () => Promise<void>)();

          const meta = await getInitializedMeta();
          if (meta.status === "booting" || meta.status === "setup") {
            await probeGatewayReady();
          }
        }

        const meta = await getInitializedMeta();
        assert.equal(meta.status, "running");
        log.info("driveToRunning complete", { sandboxId: meta.sandboxId });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },

    async stopToSnapshot(): Promise<string> {
      await stopSandbox();
      const meta = await getInitializedMeta();
      assert.equal(meta.status, "stopped");
      assert.ok(meta.snapshotId, "Should have a snapshotId after stop");
      log.info("stopToSnapshot complete", { snapshotId: meta.snapshotId });
      return meta.snapshotId!;
    },

    configureAllChannels() {
      if (!discordKeys) {
        discordKeys = generateDiscordKeyPair();
      }
      const slackSigningSecret = "test-slack-signing-secret-shared";
      const telegramWebhookSecret = "test-telegram-webhook-secret-shared";

      mutateMeta((meta) => {
        meta.channels.slack = {
          signingSecret: slackSigningSecret,
          botToken: "xoxb-shared-test-bot-token",
          configuredAt: Date.now(),
        };
        meta.channels.telegram = {
          botToken: "shared-test-telegram-bot-token",
          webhookSecret: telegramWebhookSecret,
          webhookUrl:
            "https://test.example.com/api/channels/telegram/webhook",
          botUsername: "shared_test_bot",
          configuredAt: Date.now(),
        };
        meta.channels.discord = {
          publicKey: discordKeys!.publicKeyHex,
          applicationId: "shared-test-discord-app-id",
          botToken: "shared-test-discord-bot-token",
          configuredAt: Date.now(),
        };
      });

      log.info("configureAllChannels complete");

      return {
        slackSigningSecret,
        telegramWebhookSecret,
        discordPublicKeyHex: discordKeys.publicKeyHex,
        discordPrivateKey: discordKeys.privateKey,
      };
    },

    installDefaultGatewayHandlers(gatewayReply = "Hello from OpenClaw") {
      fakeFetch.onPost(/\/v1\/chat\/completions/, () =>
        chatCompletionsResponse(gatewayReply),
      );
      fakeFetch.onPost(/slack\.com\/api/, () => slackOkResponse());
      fakeFetch.onPost(/api\.telegram\.org/, () => telegramOkResponse());
      fakeFetch.onPatch(/discord\.com/, () => discordOkResponse());
      fakeFetch.onPost(/discord\.com/, () => discordOkResponse());
      fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
      fakeFetch.onGet(/slack\.com\/api\/conversations\.replies/, () =>
        Response.json({ ok: true, messages: [] }),
      );
      log.info("installDefaultGatewayHandlers complete", { gatewayReply });
    },
  };

  return harness;
}

/**
 * Convenience wrapper that runs a test function within a harness,
 * ensuring teardown even on failure.
 */
export async function withHarness(
  fn: (harness: ScenarioHarness) => Promise<void>,
  options?: { controllerDelay?: number; authMode?: AuthMode | "none" },
): Promise<void> {
  const harness = createScenarioHarness(options);
  try {
    await fn(harness);
  } finally {
    harness.teardown();
  }
}

// ---------------------------------------------------------------------------
// Diagnostic helper for node:test TestContext
// ---------------------------------------------------------------------------

/**
 * Dump full diagnostic output on test failure.
 *
 * Call in a test's `finally` block:
 * ```ts
 * test("my test", async (t) => {
 *   const h = createScenarioHarness();
 *   try {
 *     // ... test body ...
 *   } catch (err) {
 *     await dumpDiagnostics(t, h);
 *     throw err;
 *   } finally {
 *     h.teardown();
 *   }
 * });
 * ```
 */
export async function dumpDiagnostics(
  t: { diagnostic: (msg: string) => void },
  h: ScenarioHarness,
): Promise<void> {
  t.diagnostic("=== TIMELINE ===\n" + h.formatTimeline());
  t.diagnostic("=== QUEUES ===\n" + (await h.formatQueues()));
  t.diagnostic("=== LAST REQUESTS ===\n" + h.formatLastRequests(10));
  t.diagnostic("=== RECENT LOGS ===\n" + h.formatRecentLogs(30));
}
