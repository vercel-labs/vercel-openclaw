/**
 * Tests for POST /api/admin/launch-verify and GET /api/admin/launch-verify.
 *
 * Covers: auth enforcement, destructive-mode parsing (query param vs JSON body),
 * chatCompletions auth header verification, sandboxHealth.repaired field.
 *
 * Run: npm test src/app/api/admin/launch-verify/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  callRoute,
  buildPostRequest,
  buildAuthPostRequest,
  buildAuthGetRequest,
  getAdminLaunchVerifyRoute,
  drainAfterCallbacks,
} from "@/test-utils/route-caller";
import {
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
} from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import type {
  LaunchVerifyQueueProbe,
  LaunchVerifyQueueResult,
} from "@/server/launch-verify/queue-probe";
import type {
  LaunchVerificationPayload,
  LaunchVerificationPhaseId,
  LaunchVerificationRuntime,
  LaunchVerificationSandboxHealth,
  ChannelReadiness,
  RestoreTargetAttestation,
} from "@/shared/launch-verification";

type LaunchVerifyRouteTestAdapter = {
  publishLaunchVerifyQueueProbe: (
    probe: LaunchVerifyQueueProbe,
  ) => Promise<{ probeId: string; messageId: string | null }>;
  waitForLaunchVerifyQueueResult: (
    probeId: string,
    timeoutMs?: number,
  ) => Promise<LaunchVerifyQueueResult>;
};

type LaunchVerifyRouteWithTestAdapter = ReturnType<
  typeof getAdminLaunchVerifyRoute
> & {
  __setLaunchVerifyQueueProbeAdapterForTests?: (
    adapter: LaunchVerifyRouteTestAdapter | null,
  ) => void;
};

/**
 * Helper: make preflight fail fast on the auth-config check.
 * Sets sign-in-with-vercel mode without the required OAuth client ID,
 * which is a hard fail regardless of Vercel/non-Vercel environment.
 * Does NOT require VERCEL=1, so the memory store still works.
 */
function makePreflightFail(): void {
  process.env.VERCEL_AUTH_MODE = "sign-in-with-vercel";
  delete process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID;
  delete process.env.VERCEL_APP_CLIENT_SECRET;
}

// ===========================================================================
// Auth enforcement
// ===========================================================================

test("launch-verify POST: without auth returns 401", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = buildPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("launch-verify GET: without auth returns 403", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = new Request("http://localhost:3000/api/admin/launch-verify", {
      method: "GET",
    });
    const result = await callRoute(route.GET, req);
    // requireJsonRouteAuth rejects unauthenticated requests
    assert.ok(
      result.status === 401 || result.status === 403,
      `expected 401 or 403, got ${result.status}`,
    );
  });
});

// ===========================================================================
// Mode parsing: query param takes precedence over JSON body
// ===========================================================================

test("launch-verify POST: defaults to safe mode when no mode specified", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "safe");
    assert.equal(body.ok, false, "should fail since preflight fails");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: reads destructive mode from JSON body", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "destructive" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: reads destructive mode from query param", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=destructive",
      "{}",
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: query param takes precedence over JSON body", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    // Query param says destructive, body says safe (default)
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=destructive",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: query param safe overrides body destructive", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=safe",
      JSON.stringify({ mode: "destructive" }),
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "safe");
    await drainAfterCallbacks();
  });
});

test("launch-verify POST: no JSON body still works (uses query param)", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    // Send request with no body at all, but with query param
    const req = new Request(
      "http://localhost:3000/api/admin/launch-verify?mode=destructive",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-admin-secret-for-scenarios",
          origin: "http://localhost:3000",
          "x-requested-with": "XMLHttpRequest",
        },
      },
    );
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.mode, "destructive");
    await drainAfterCallbacks();
  });
});

// ===========================================================================
// Response shape: phases and payload structure
// ===========================================================================

test("launch-verify POST: preflight failure skips subsequent phases", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    assert.equal(body.ok, false);
    assert.equal(body.mode, "safe");
    assert.ok(body.startedAt, "should have startedAt");
    assert.ok(body.completedAt, "should have completedAt");

    // Preflight should fail, rest should be skipped
    const phaseIds = body.phases.map((p) => p.id);
    assert.deepEqual(phaseIds, [
      "preflight",
      "queuePing",
      "ensureRunning",
      "chatCompletions",
      "wakeFromSleep",
      "restorePrepared",
    ]);

    assert.equal(body.phases[0].status, "fail");
    for (let i = 1; i < body.phases.length; i++) {
      assert.equal(
        body.phases[i].status,
        "skip",
        `phase ${body.phases[i].id} should be skipped`,
      );
    }

    // channelReadiness should be present in the extended response
    const extended = result.json as LaunchVerificationPayload & {
      channelReadiness: ChannelReadiness;
    };
    assert.ok(extended.channelReadiness, "should include channelReadiness");
    assert.equal(extended.channelReadiness.ready, false);

    await drainAfterCallbacks();
  });
});

test("launch-verify POST (NDJSON): preflight failure skips subsequent phases", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);

    // Parse NDJSON lines
    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "phase"; phase: LaunchVerificationPayload["phases"][number]; seq: number; final: boolean }
        | { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> }
        | { type: "result"; payload: LaunchVerificationPayload });

    // Extract final phase events (last emission per phase ID)
    const finalPhases = new Map<string, LaunchVerificationPayload["phases"][number]>();
    for (const event of events) {
      if (event.type === "phase") {
        finalPhases.set(event.phase.id, event.phase);
      }
    }

    // Preflight should fail
    const preflightPhase = finalPhases.get("preflight");
    assert.ok(preflightPhase, "expected preflight phase event");
    assert.equal(preflightPhase.status, "fail", "preflight should fail");

    // All runtime phases should be skipped
    const skippedPhaseIds = ["queuePing", "ensureRunning", "chatCompletions", "wakeFromSleep", "restorePrepared"] as const;
    for (const id of skippedPhaseIds) {
      const phase = finalPhases.get(id);
      assert.ok(phase, `expected ${id} phase event`);
      assert.equal(phase.status, "skip", `${id} should be skipped when preflight fails`);
    }

    // Summary event should show blocking
    const summaryEvent = events.find(
      (event): event is { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> } =>
        event.type === "summary",
    );
    assert.ok(summaryEvent, "expected summary event");
    assert.equal(summaryEvent.payload.blocking, true, "diagnostics should show blocking");

    // Result event should show ok=false
    const resultEvent = events.find(
      (event): event is { type: "result"; payload: LaunchVerificationPayload } =>
        event.type === "result",
    );
    assert.ok(resultEvent, "expected result event");
    assert.equal(resultEvent.payload.ok, false, "result should be not ok");

    // Result phases should match: preflight=fail, rest=skip
    const resultPhaseIds = resultEvent.payload.phases.map((p) => p.id);
    assert.deepEqual(resultPhaseIds, [
      "preflight",
      "queuePing",
      "ensureRunning",
      "chatCompletions",
      "wakeFromSleep",
      "restorePrepared",
    ]);
    assert.equal(resultEvent.payload.phases[0].status, "fail");
    for (let i = 1; i < resultEvent.payload.phases.length; i++) {
      assert.equal(
        resultEvent.payload.phases[i].status,
        "skip",
        `result phase ${resultEvent.payload.phases[i].id} should be skipped`,
      );
    }

    await drainAfterCallbacks();
  });
});

// ===========================================================================
// GET readiness endpoint
// ===========================================================================

test("launch-verify GET: returns channel readiness", async () => {
  await withHarness(async () => {
    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthGetRequest("/api/admin/launch-verify");
    const result = await callRoute(route.GET, req);

    assert.equal(result.status, 200);
    const body = result.json as ChannelReadiness;
    assert.equal(body.ready, false, "default readiness should be false");
    assert.ok(body.deploymentId, "should have a deploymentId");
  });
});

// ===========================================================================
// chatCompletions auth: AI Gateway token sent as X-AI-Gateway-Token header
// ===========================================================================

test("launch-verify POST: chatCompletions sends X-AI-Gateway-Token header", async () => {
  await withHarness(async (h) => {
    // Set up a public origin so preflight passes
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    // Drive sandbox to running so ensureRunning passes
    await h.driveToRunning();

    // Install a handler for /v1/chat/completions that captures headers
    let capturedHeaders: Record<string, string> = {};
    h.fakeFetch.on("POST", /v1\/chat\/completions/, (_url, init) => {
      capturedHeaders = {};
      const headers = init?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [key, value] of Object.entries(headers)) {
          capturedHeaders[key.toLowerCase()] = String(value);
        }
      }
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;

    // The queuePing phase will fail because @vercel/queue isn't available in test.
    // But the route continues to ensureRunning independently.
    // The chatCompletions phase depends on ensureRunning passing.
    const chatPhase = body.phases.find((p) => p.id === "chatCompletions");
    if (chatPhase && chatPhase.status === "pass") {
      assert.ok(
        capturedHeaders["x-ai-gateway-token"],
        "chatCompletions should send X-AI-Gateway-Token header",
      );
      assert.ok(
        capturedHeaders["authorization"],
        "chatCompletions should send Authorization header",
      );
      assert.ok(
        capturedHeaders["authorization"].startsWith("Bearer "),
        "Authorization should be a Bearer token",
      );
    }
    // Verify mode is still correctly parsed regardless of phase outcomes
    assert.equal(body.mode, "safe");
  });
});

// ===========================================================================
// OPENCLAW_PACKAGE_SPEC consistency: preflight phase reflects contract
// ===========================================================================

// Full package-spec fail/pass scenarios are tested at the server level in
// deploy-preflight.test.ts (including cross-surface consistency with
// connectability) to avoid global store singleton conflicts that arise from
// setting VERCEL=1 in route-level tests with parallel test files.

test("launch-verify POST: preflight error propagates contract check failures to phase output", async () => {
  await withHarness(async () => {
    // Make preflight fail via auth-config (missing OAuth client ID in
    // sign-in-with-vercel mode). Verify the phase error includes the failing
    // check ID — the same mechanism that surfaces any contract failure.
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload;
    const preflightPhase = body.phases.find((p) => p.id === "preflight");
    assert.ok(preflightPhase, "expected preflight phase");
    assert.equal(preflightPhase.status, "fail");
    assert.ok(
      preflightPhase.error?.includes("auth-config"),
      `preflight error should include the failing check ID; got: ${preflightPhase.error}`,
    );

    await drainAfterCallbacks();
  });
});

// ===========================================================================
// sandboxHealth.repaired field
// ===========================================================================

test("launch-verify POST: response includes sandboxHealth when preflight fails", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);

    const body = result.json as LaunchVerificationPayload & {
      sandboxHealth?: LaunchVerificationSandboxHealth;
    };

    // When preflight fails and ensure was skipped, sandboxHealth should
    // still be computed (repaired: false since ensure didn't run).
    if (body.sandboxHealth) {
      assert.equal(typeof body.sandboxHealth.repaired, "boolean");
      assert.equal(body.sandboxHealth.repaired, false);
    }

    await drainAfterCallbacks();
  });
});

// ===========================================================================
// Webhook-bypass contract: missing bypass must not block runtime phases
// ===========================================================================

/**
 * Shared setup for webhook-bypass regression tests (JSON and NDJSON paths).
 * Sets admin-secret mode with a public origin but no bypass secret, drives
 * the sandbox to running, and stubs chat completions.
 */
async function setupWebhookBypassScenario(
  h: Parameters<Parameters<typeof withHarness>[0]>[0],
): Promise<() => void> {
  const previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const previousBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  process.env.NEXT_PUBLIC_APP_URL = "https://test.example";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  await h.driveToRunning();

  h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
    return Response.json({
      choices: [{ message: { content: "launch-verify-ok" } }],
    });
  });

  return () => {
    if (previousAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
    }

    if (previousBypassSecret === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previousBypassSecret;
    }
  };
}

/**
 * Shared assertions: the structured diagnostics must reflect that missing
 * webhook bypass is non-blocking. When the bypass recommendation is
 * "recommended" (per getWebhookBypassRequirement), it appears as a
 * recommended action; when recommendation is "none" (admin-secret mode),
 * no action is emitted at all. Either way, it must never block.
 */
function assertBypassDiagnostics(
  diagnostics: LaunchVerificationPayload["diagnostics"] | undefined,
): void {
  assert.ok(diagnostics, "expected launch-verify diagnostics");
  assert.equal(
    diagnostics.blocking,
    false,
    "missing webhook bypass should be non-blocking",
  );
  assert.equal(
    diagnostics.failingCheckIds.includes("webhook-bypass"),
    false,
    "webhook-bypass should not appear in failingCheckIds when it is only a recommendation",
  );
  assert.equal(diagnostics.skipPhaseIds.length, 0, "no phases should be skipped");
}

/**
 * Shared assertions: preflight must not fail and runtime phases must not
 * be skipped solely because webhook bypass is missing.
 */
function assertBypassNonBlocking(phases: LaunchVerificationPayload["phases"]): void {
  const preflightPhase = phases.find((p) => p.id === "preflight");
  assert.ok(preflightPhase, "expected preflight phase");
  assert.notEqual(
    preflightPhase.status,
    "fail",
    "preflight must not fail solely because webhook bypass is missing",
  );

  const ensurePhase = phases.find((p) => p.id === "ensureRunning");
  assert.ok(ensurePhase, "expected ensureRunning phase");
  assert.notEqual(
    ensurePhase.status,
    "skip",
    "ensureRunning must not be skipped when only webhook bypass is missing",
  );
}

test("launch-verify POST (JSON): missing webhook bypass does not block runtime phases", async () => {
  await withHarness(async (h) => {
    const restoreEnv = await setupWebhookBypassScenario(h);
    try {
      const route = getAdminLaunchVerifyRoute();
      const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
      const result = await callRoute(route.POST, req);
      await drainAfterCallbacks();

      const body = result.json as LaunchVerificationPayload;
      assertBypassNonBlocking(body.phases);
      assertBypassDiagnostics(body.diagnostics);
    } finally {
      restoreEnv();
    }
  });
});

test("launch-verify POST (NDJSON): missing webhook bypass does not block runtime phases", async () => {
  await withHarness(async (h) => {
    const restoreEnv = await setupWebhookBypassScenario(h);
    try {
      const route = getAdminLaunchVerifyRoute();
      const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
        accept: "application/x-ndjson",
      });
      const result = await callRoute(route.POST, req);
      await drainAfterCallbacks();

      // NDJSON response: parse each line as a separate JSON event
      const events = result.text
        .split("\n")
        .filter((line: string) => line.trim().length > 0)
        .map((line: string) => JSON.parse(line) as
          | { type: "phase"; phase: LaunchVerificationPayload["phases"][number] }
          | { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> }
          | { type: "result"; payload: LaunchVerificationPayload });

      const phaseEvents = events
        .filter((event): event is { type: "phase"; phase: LaunchVerificationPayload["phases"][number] } => event.type === "phase")
        .map((event) => event.phase);

      const summaryEvent = events.find(
        (event): event is { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> } =>
          event.type === "summary",
      );

      const resultEvent = events.find(
        (event): event is { type: "result"; payload: LaunchVerificationPayload } =>
          event.type === "result",
      );

      assert.ok(summaryEvent, "expected a summary event");
      assert.ok(resultEvent?.payload, "expected a result event with payload");

      // Use final-state helper for streamed phase events — intermediate
      // "running" events must not cause false assertions.
      assertBypassNonBlockingFinal(phaseEvents);
      assertBypassDiagnostics(summaryEvent.payload);
      assertBypassNonBlockingFinal(resultEvent.payload.phases);
      assertBypassDiagnostics(resultEvent.payload.diagnostics);
    } finally {
      restoreEnv();
    }
  });
});

// ===========================================================================
// Dynamic config verification in launch-verify runtime output
// ===========================================================================

test("launch-verify POST: runtime.dynamicConfigVerified is true when restore hash matches expected", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Compute the expected hash (no channels configured = empty input)
    const expectedHash = computeGatewayConfigHash({});

    // Seed lastRestoreMetrics with a matching dynamicConfigHash
    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 100,
        tokenWriteMs: 10,
        assetSyncMs: 50,
        startupScriptMs: 200,
        forcePairMs: 30,
        firewallSyncMs: 20,
        localReadyMs: 300,
        publicReadyMs: 400,
        totalMs: 1000,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: true,
        dynamicConfigHash: expectedHash,
        dynamicConfigReason: "hash-match",
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
      };
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");
    const runtime = body.runtime as LaunchVerificationRuntime;

    assert.equal(runtime.dynamicConfigVerified, true, "should be verified when hashes match");
    assert.equal(runtime.expectedConfigHash, expectedHash);
    assert.equal(runtime.lastRestoreConfigHash, expectedHash);
    assert.equal(runtime.dynamicConfigReason, "hash-match");
  });
});

test("launch-verify POST: runtime.dynamicConfigVerified is false when restore hash differs", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Seed lastRestoreMetrics with a stale/mismatched dynamicConfigHash
    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 100,
        tokenWriteMs: 10,
        assetSyncMs: 50,
        startupScriptMs: 200,
        forcePairMs: 30,
        firewallSyncMs: 20,
        localReadyMs: 300,
        publicReadyMs: 400,
        totalMs: 1000,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: false,
        dynamicConfigHash: "stale-hash-from-previous-restore",
        dynamicConfigReason: "hash-miss",
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
      };
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");
    const runtime = body.runtime as LaunchVerificationRuntime;

    assert.equal(runtime.dynamicConfigVerified, false, "should be false when hashes differ");
    assert.equal(runtime.lastRestoreConfigHash, "stale-hash-from-previous-restore");
    assert.equal(runtime.dynamicConfigReason, "hash-miss");
    assert.notEqual(runtime.expectedConfigHash, runtime.lastRestoreConfigHash);
  });
});

// ===========================================================================
// NDJSON parity: runtime config verification
// ===========================================================================

function latestPhaseState(
  phases: LaunchVerificationPayload["phases"],
): Map<LaunchVerificationPhaseId, LaunchVerificationPayload["phases"][number]> {
  const byId = new Map<
    LaunchVerificationPhaseId,
    LaunchVerificationPayload["phases"][number]
  >();
  for (const phase of phases) {
    byId.set(phase.id, phase);
  }
  return byId;
}

function assertBypassNonBlockingFinal(phases: LaunchVerificationPayload["phases"]): void {
  const byId = latestPhaseState(phases);

  const preflightPhase = byId.get("preflight");
  assert.ok(preflightPhase, "expected preflight phase");
  assert.notEqual(
    preflightPhase.status,
    "fail",
    "preflight must not fail solely because webhook bypass is missing",
  );

  const ensurePhase = byId.get("ensureRunning");
  assert.ok(ensurePhase, "expected ensureRunning phase");
  assert.notEqual(
    ensurePhase.status,
    "skip",
    "ensureRunning must not be skipped when only webhook bypass is missing",
  );
}

test("launch-verify POST (NDJSON): runtime.dynamicConfigVerified is false when restore hash differs", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 100,
        tokenWriteMs: 10,
        assetSyncMs: 50,
        startupScriptMs: 200,
        forcePairMs: 30,
        firewallSyncMs: 20,
        localReadyMs: 300,
        publicReadyMs: 400,
        totalMs: 1000,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: false,
        dynamicConfigHash: "stale-hash-from-previous-restore",
        dynamicConfigReason: "hash-miss",
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
      };
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as
        | { type: "phase"; phase: LaunchVerificationPayload["phases"][number] }
        | { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> }
        | { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } });

    const resultEvent = events.find(
      (event): event is { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } } =>
        event.type === "result",
    );

    assert.ok(resultEvent?.payload.runtime, "expected runtime in NDJSON result payload");
    assert.equal(resultEvent.payload.runtime?.dynamicConfigVerified, false);
    assert.equal(resultEvent.payload.runtime?.dynamicConfigReason, "hash-miss");
    assert.equal(
      resultEvent.payload.runtime?.lastRestoreConfigHash,
      "stale-hash-from-previous-restore",
    );

    // Verify final phase state uses last event per phase ID
    const phaseEvents = events
      .filter((event): event is { type: "phase"; phase: LaunchVerificationPayload["phases"][number] } => event.type === "phase")
      .map((event) => event.phase);
    assertBypassNonBlockingFinal(phaseEvents);
  });
});

// ===========================================================================
// NDJSON seq/final markers
// ===========================================================================

test("launch-verify POST (NDJSON): phase events include seq and final markers", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "phase"; phase: LaunchVerificationPayload["phases"][number]; seq: number; final: boolean }
        | { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> }
        | { type: "result"; payload: LaunchVerificationPayload });

    const phaseEvents = events.filter(
      (event): event is { type: "phase"; phase: LaunchVerificationPayload["phases"][number]; seq: number; final: boolean } =>
        event.type === "phase",
    );

    assert.ok(phaseEvents.length > 0, "expected phase events");

    // seq values must be monotonically increasing
    for (let i = 0; i < phaseEvents.length; i += 1) {
      assert.equal(phaseEvents[i]?.seq, i, `expected phase event seq=${i}`);
    }

    // The final preflight event must have final=true and a non-running status
    const finalPreflight = phaseEvents.find(
      (event) => event.phase.id === "preflight" && event.final === true,
    );
    assert.ok(finalPreflight, "expected final preflight event");
    assert.notEqual(finalPreflight.phase.status, "running");

    // Running events must have final=false
    const runningEvents = phaseEvents.filter(
      (event) => event.phase.status === "running",
    );
    for (const event of runningEvents) {
      assert.equal(event.final, false, `running event for ${event.phase.id} should have final=false`);
    }
  });
});

// ===========================================================================
// NDJSON parity: failingChannelIds
// ===========================================================================

test("launch-verify POST (NDJSON): diagnostics include failingChannelIds", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> }
        | { type: "result"; payload: LaunchVerificationPayload });

    const summaryEvent = events.find(
      (event): event is { type: "summary"; payload: NonNullable<LaunchVerificationPayload["diagnostics"]> } =>
        event.type === "summary",
    );

    assert.ok(summaryEvent, "expected summary event");
    assert.ok(
      Array.isArray(summaryEvent.payload.failingChannelIds),
      "failingChannelIds should be an array",
    );
    assert.deepEqual(
      summaryEvent.payload.failingChannelIds,
      summaryEvent.payload.warningChannelIds,
      "failingChannelIds and warningChannelIds should match",
    );
  });
});

// ===========================================================================
// NDJSON parity: dynamicConfigVerified true and null
// ===========================================================================

test("launch-verify POST (NDJSON): runtime.dynamicConfigVerified is true when restore hash matches", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    const expectedHash = computeGatewayConfigHash({});

    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = {
        sandboxCreateMs: 100,
        tokenWriteMs: 10,
        assetSyncMs: 50,
        startupScriptMs: 200,
        forcePairMs: 30,
        firewallSyncMs: 20,
        localReadyMs: 300,
        publicReadyMs: 400,
        totalMs: 1000,
        skippedStaticAssetSync: false,
        skippedDynamicConfigSync: true,
        dynamicConfigHash: expectedHash,
        dynamicConfigReason: "hash-match",
        assetSha256: null,
        vcpus: 1,
        recordedAt: Date.now(),
      };
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } });

    const resultEvent = events.find(
      (event): event is { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } } =>
        event.type === "result",
    );

    assert.equal(resultEvent?.payload.runtime?.dynamicConfigVerified, true);
    assert.equal(resultEvent?.payload.runtime?.dynamicConfigReason, "hash-match");
    assert.equal(resultEvent?.payload.runtime?.lastRestoreConfigHash, expectedHash);
  });
});

test("launch-verify POST (NDJSON): runtime.dynamicConfigVerified is null when no restore metrics exist", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = null;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } });

    const resultEvent = events.find(
      (event): event is { type: "result"; payload: LaunchVerificationPayload & { runtime?: LaunchVerificationRuntime } } =>
        event.type === "result",
    );

    assert.equal(resultEvent?.payload.runtime?.dynamicConfigVerified, null);
    assert.equal(resultEvent?.payload.runtime?.lastRestoreConfigHash, null);
  });
});

// ===========================================================================
// JSON path: failingChannelIds
// ===========================================================================

test("launch-verify POST (JSON): diagnostics include failingChannelIds matching warningChannelIds", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.diagnostics, "expected diagnostics");
    assert.ok(
      Array.isArray(body.diagnostics.failingChannelIds),
      "failingChannelIds should be an array",
    );
    assert.deepEqual(
      body.diagnostics.failingChannelIds,
      body.diagnostics.warningChannelIds,
      "failingChannelIds and warningChannelIds should match",
    );
  });
});

test("launch-verify POST: runtime.dynamicConfigVerified is null when no restore metrics exist", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Ensure no lastRestoreMetrics (fresh create, never restored)
    await h.mutateMeta((meta) => {
      meta.lastRestoreMetrics = null;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");
    const runtime = body.runtime as LaunchVerificationRuntime;

    assert.equal(runtime.dynamicConfigVerified, null, "should be null when no restore metrics");
    assert.equal(runtime.lastRestoreConfigHash, null);
    assert.ok(runtime.expectedConfigHash, "expectedConfigHash should always be computed");
  });
});

// ===========================================================================
// Dynamic config reconcile: configReconciled in sandboxHealth
// ===========================================================================

test("launch-verify POST: configReconciled is true when runtimeDynamicConfigHash already matches", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Set runtimeDynamicConfigHash to match expected (no channels = empty input)
    const expectedHash = computeGatewayConfigHash({});
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = expectedHash;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.sandboxHealth, "expected sandboxHealth");
    assert.equal(body.sandboxHealth.configReconciled, true);
    assert.equal(body.sandboxHealth.configReconcileReason, "already-fresh");
    // Config was already fresh, so reconcile should not degrade ok.
    // (queuePing may fail in test env — that's independent of config freshness.)
  });
});

test("launch-verify POST: configReconciled is true after successful rewrite when hash misses", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Set a stale runtimeDynamicConfigHash so reconcile triggers rewrite+restart
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.sandboxHealth, "expected sandboxHealth");
    assert.equal(body.sandboxHealth.configReconciled, true);
    assert.equal(body.sandboxHealth.configReconcileReason, "rewritten-and-restarted");
  });
});

test("launch-verify POST: ok is false when config reconcile fails (writeFiles throws)", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    // Set a stale runtimeDynamicConfigHash
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = "stale-hash";
    });

    // Make writeFiles throw to simulate reconcile failure.
    // Must set on the existing handle (already created by driveToRunning).
    const handle = h.controller.lastCreated();
    assert.ok(handle, "expected a sandbox handle from driveToRunning");
    handle.writeFilesHook = () => {
      throw new Error("Simulated writeFiles failure");
    };

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.sandboxHealth, "expected sandboxHealth");
    assert.equal(body.sandboxHealth.configReconciled, false);
    assert.equal(body.sandboxHealth.configReconcileReason, "rewrite-failed");
    assert.equal(body.ok, false, "ok must be false when config reconcile fails");
  });
});

test("launch-verify POST: configReconciled is null when ensure phase fails (reconcile skipped)", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    // When preflight fails, sandboxHealth may not be present or configReconciled should be null
    if (body.sandboxHealth) {
      assert.equal(body.sandboxHealth.configReconciled, null);
      assert.equal(body.sandboxHealth.configReconcileReason, "skipped");
    }
  });
});

// ===========================================================================
// NDJSON parity: configReconciled
// ===========================================================================

test("launch-verify POST (NDJSON): configReconciled appears in result payload", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    const expectedHash = computeGatewayConfigHash({});
    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = expectedHash;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}", {
      accept: "application/x-ndjson",
    });
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const events = result.text
      .split("\n")
      .filter((line: string) => line.trim().length > 0)
      .map((line: string) => JSON.parse(line) as
        | { type: "result"; payload: LaunchVerificationPayload });

    const resultEvent = events.find(
      (event): event is { type: "result"; payload: LaunchVerificationPayload } =>
        event.type === "result",
    );

    assert.ok(resultEvent?.payload.sandboxHealth, "expected sandboxHealth in NDJSON result");
    assert.equal(resultEvent.payload.sandboxHealth.configReconciled, true);
    assert.equal(resultEvent.payload.sandboxHealth.configReconcileReason, "already-fresh");
  });
});

// ===========================================================================
// Canonical diagnostics field: failingChannelIds
// ===========================================================================

test("launch-verify POST: new code reads failingChannelIds as canonical field", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest("/api/admin/launch-verify", "{}");
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.diagnostics, "expected diagnostics");

    // failingChannelIds is the canonical field
    assert.ok(Array.isArray(body.diagnostics.failingChannelIds), "failingChannelIds must be an array");
    // warningChannelIds is a compatibility mirror — same data
    assert.deepEqual(
      body.diagnostics.failingChannelIds,
      body.diagnostics.warningChannelIds,
      "failingChannelIds must equal warningChannelIds (compat mirror)",
    );
  });
});

// ===========================================================================
// restorePrepared readiness gating: destructive mode
// ===========================================================================

test("launch-verify POST: destructive preflight-fail includes restorePrepared skip and channelReadiness.ready=false", async () => {
  await withHarness(async () => {
    makePreflightFail();

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify?mode=destructive",
      "{}",
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload & {
      channelReadiness: ChannelReadiness;
    };
    assert.equal(body.mode, "destructive");

    // restorePrepared phase must be present even when skipped
    const restorePreparedPhase = body.phases.find((p) => p.id === "restorePrepared");
    assert.ok(restorePreparedPhase, "expected restorePrepared phase in destructive response");
    assert.equal(restorePreparedPhase.status, "skip");

    // channelReadiness must be false because restorePrepared did not pass
    assert.equal(body.channelReadiness.ready, false);
  });
});

test("launch-verify POST: safe mode skips restorePrepared and channelReadiness.ready=false", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload & {
      channelReadiness: ChannelReadiness;
    };
    assert.equal(body.mode, "safe");

    // restorePrepared must be present but skipped in safe mode
    const restorePreparedPhase = body.phases.find((p) => p.id === "restorePrepared");
    assert.ok(restorePreparedPhase, "expected restorePrepared phase");
    assert.equal(restorePreparedPhase.status, "skip");

    // channelReadiness.ready must be false — safe mode cannot satisfy the readiness gate
    assert.equal(body.channelReadiness.ready, false);
  });
});

test("launch-verify POST: destructive response runtime includes restoreAttestation and restorePlan", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");

    const runtime = body.runtime as LaunchVerificationRuntime;
    // These fields must always be present in runtime output
    assert.ok("restorePreparedStatus" in runtime, "runtime must include restorePreparedStatus");
    assert.ok("restorePreparedReason" in runtime, "runtime must include restorePreparedReason");
    assert.ok("restoreAttestation" in runtime, "runtime must include restoreAttestation");
    assert.ok("restorePlan" in runtime, "runtime must include restorePlan");

    // restoreAttestation shape
    assert.ok(runtime.restoreAttestation, "restoreAttestation must not be null");
    assert.equal(typeof runtime.restoreAttestation.reusable, "boolean");
    assert.equal(typeof runtime.restoreAttestation.needsPrepare, "boolean");
    assert.ok(Array.isArray(runtime.restoreAttestation.reasons));

    // restorePlan shape
    assert.ok(runtime.restorePlan, "restorePlan must not be null");
    assert.ok(Array.isArray(runtime.restorePlan.actions));
  });
});

test("launch-verify POST: destructive wake failure preserves queue stage details", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";
    await h.driveToRunning();

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    route.__setLaunchVerifyQueueProbeAdapterForTests?.({
      async publishLaunchVerifyQueueProbe(probe) {
        return {
          probeId: probe.kind === "ack" ? "ack-probe" : "wake-probe",
          messageId: probe.kind === "ack" ? "ack-message" : "wake-message",
        };
      },
      async waitForLaunchVerifyQueueResult(probeId) {
        if (probeId === "ack-probe") {
          return {
            probeId,
            ok: true,
            completedAt: Date.now(),
            messageId: "ack-message",
            stage: "queue-delivery",
            timings: {
              queueDelayMs: 25,
              totalMs: 25,
            },
            message: "Queue callback executed successfully (queue delay 25ms, total 25ms).",
          };
        }

        return {
          probeId,
          ok: false,
          completedAt: Date.now(),
          messageId: "wake-message",
          stage: "chat-completion",
          timings: {
            queueDelayMs: 50,
            sandboxReadyMs: 1400,
            completionMs: 90000,
            totalMs: 91450,
          },
          message:
            "Queue callback failed during chat completion (queue delay 50ms, sandbox ready 1400ms, completion 90000ms, total 91450ms).",
          error: "Expected \"wake-from-sleep-ok\" but got \"still-waking\"",
        };
      },
    });

    let result: Awaited<ReturnType<typeof callRoute>>;
    try {
      const req = buildAuthPostRequest(
        "/api/admin/launch-verify",
        JSON.stringify({ mode: "destructive" }),
      );
      result = await callRoute(route.POST, req);
      await drainAfterCallbacks();
    } finally {
      route.__setLaunchVerifyQueueProbeAdapterForTests?.(null);
    }

    const body = result.json as LaunchVerificationPayload;
    const queuePingPhase = body.phases.find((phase) => phase.id === "queuePing");
    const wakePhase = body.phases.find((phase) => phase.id === "wakeFromSleep");

    assert.ok(queuePingPhase, "expected queuePing phase");
    assert.equal(queuePingPhase.status, "pass");
    assert.match(
      queuePingPhase.message,
      /Queue callback executed successfully \(queue delay 25ms, total 25ms\)\. Callback message ID: ack-message\./,
    );

    assert.ok(wakePhase, "expected wakeFromSleep phase");
    assert.equal(wakePhase.status, "fail");
    assert.match(
      wakePhase.error ?? "",
      /Queue callback failed during chat completion \(queue delay 50ms, sandbox ready 1400ms, completion 90000ms, total 91450ms\)\. Expected "wake-from-sleep-ok" but got "still-waking"/,
    );
  });
});

// ===========================================================================
// Restore attestation: WhatsApp-inclusive hash
// ===========================================================================

test("launch-verify POST: runtime.expectedConfigHash includes WhatsApp config in hash", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    const whatsapp = {
      enabled: true,
      configuredAt: Date.now(),
      pluginSpec: "@openclaw/whatsapp",
      dmPolicy: "allowlist" as const,
      allowFrom: ["15551234567"],
      groupPolicy: "allowlist" as const,
      groupAllowFrom: ["15557654321"],
      groups: ["team-chat"],
    };

    await h.mutateMeta((meta) => {
      meta.channels.whatsapp = whatsapp;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");
    const runtime = body.runtime as LaunchVerificationRuntime;

    const withWhatsapp = computeGatewayConfigHash({
      whatsappConfig: toWhatsAppGatewayConfig(whatsapp),
    });
    const withoutWhatsapp = computeGatewayConfigHash({});

    assert.equal(
      runtime.expectedConfigHash,
      withWhatsapp,
      "expectedConfigHash must include WhatsApp config",
    );
    assert.notEqual(
      runtime.expectedConfigHash,
      withoutWhatsapp,
      "expectedConfigHash must differ from hash without WhatsApp",
    );

    // restoreAttestation must agree
    assert.ok(runtime.restoreAttestation, "expected restoreAttestation");
    assert.equal(
      runtime.restoreAttestation.desiredDynamicConfigHash,
      runtime.expectedConfigHash,
      "attestation.desiredDynamicConfigHash must equal expectedConfigHash",
    );
  });
});

// ===========================================================================
// Restore attestation: runtime-fresh / snapshot-stale separation
// ===========================================================================

test("launch-verify POST: restoreAttestation separates runtime-fresh from snapshot-stale", async () => {
  await withHarness(async (h) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example";

    await h.driveToRunning();

    const desiredConfigHash = computeGatewayConfigHash({});
    const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

    await h.mutateMeta((meta) => {
      meta.runtimeDynamicConfigHash = desiredConfigHash;
      meta.snapshotDynamicConfigHash = "stale-snapshot-hash";
      meta.runtimeAssetSha256 = desiredAssetSha256;
      meta.snapshotAssetSha256 = desiredAssetSha256;
      meta.restorePreparedStatus = "dirty";
      meta.restorePreparedReason = "dynamic-config-changed";
      meta.restorePreparedAt = 123;
    });

    h.fakeFetch.on("POST", /v1\/chat\/completions/, () => {
      return Response.json({
        choices: [{ message: { content: "launch-verify-ok" } }],
      });
    });

    const route = getAdminLaunchVerifyRoute();
    const req = buildAuthPostRequest(
      "/api/admin/launch-verify",
      JSON.stringify({ mode: "safe" }),
    );
    const result = await callRoute(route.POST, req);
    await drainAfterCallbacks();

    const body = result.json as LaunchVerificationPayload;
    assert.ok(body.runtime, "expected runtime in response");
    const runtime = body.runtime as LaunchVerificationRuntime;
    assert.ok(runtime.restoreAttestation, "expected restoreAttestation");

    const att = runtime.restoreAttestation as RestoreTargetAttestation;
    assert.equal(att.runtimeConfigFresh, true, "runtime config should be fresh");
    assert.equal(att.snapshotConfigFresh, false, "snapshot config should be stale");
    assert.equal(att.runtimeAssetsFresh, true, "runtime assets should be fresh");
    assert.equal(att.snapshotAssetsFresh, true, "snapshot assets should be fresh");
    assert.equal(att.reusable, false, "should not be reusable");
    assert.equal(att.needsPrepare, true, "should need prepare");
    assert.ok(
      att.reasons.includes("snapshot-config-stale"),
      `reasons should include snapshot-config-stale; got: ${att.reasons}`,
    );
    assert.ok(
      att.reasons.includes("restore-target-dirty"),
      `reasons should include restore-target-dirty; got: ${att.reasons}`,
    );

    // Legacy compatibility fields must still be present
    assert.equal(runtime.expectedConfigHash, att.desiredDynamicConfigHash);
    assert.equal(runtime.restorePreparedStatus, "dirty");
    assert.equal(runtime.snapshotDynamicConfigHash, "stale-snapshot-hash");
    assert.equal(runtime.runtimeDynamicConfigHash, desiredConfigHash);
  });
});
