import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getCurrentDeploymentId,
  readChannelReadiness,
  writeChannelReadiness,
  _setChannelReadinessOverrideForTesting,
} from "@/server/launch-verify/state";
import {
  buildLaunchVerifyQueueAckMessage,
  buildLaunchVerifyQueueFailureMessage,
  buildLaunchVerifyQueueSuccessMessage,
} from "@/server/launch-verify/queue-probe";
import { isChannelReady } from "@/shared/launch-verification";
import type {
  LaunchVerificationPayload,
  LaunchVerificationPhase,
} from "@/shared/launch-verification";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  resetEnv();
  _setChannelReadinessOverrideForTesting(null);
});

function makeAllPassPhases(): LaunchVerificationPhase[] {
  return [
    { id: "preflight", status: "pass", durationMs: 10, message: "ok" },
    { id: "queuePing", status: "pass", durationMs: 10, message: "ok" },
    { id: "ensureRunning", status: "pass", durationMs: 10, message: "ok" },
    { id: "chatCompletions", status: "pass", durationMs: 10, message: "ok" },
    { id: "wakeFromSleep", status: "pass", durationMs: 10, message: "ok" },
    { id: "restorePrepared", status: "pass", durationMs: 10, message: "ok" },
  ];
}

function makeDestructivePayload(
  overrides: Partial<LaunchVerificationPayload> = {},
): LaunchVerificationPayload {
  return {
    ok: true,
    mode: "destructive",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    phases: makeAllPassPhases(),
    ...overrides,
  };
}

function makeSafePayload(
  overrides: Partial<LaunchVerificationPayload> = {},
): LaunchVerificationPayload {
  return {
    ok: true,
    mode: "safe",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    phases: [
      { id: "preflight", status: "pass", durationMs: 10, message: "ok" },
      { id: "queuePing", status: "pass", durationMs: 10, message: "ok" },
      { id: "ensureRunning", status: "pass", durationMs: 10, message: "ok" },
      { id: "chatCompletions", status: "pass", durationMs: 10, message: "ok" },
      { id: "wakeFromSleep", status: "skip", durationMs: 0, message: "Not run in safe mode." },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// writeChannelReadiness + readChannelReadiness round-trip
// ---------------------------------------------------------------------------

test("writeChannelReadiness stores and readChannelReadiness retrieves correct ChannelReadiness", async () => {
  const payload = makeDestructivePayload();
  const written = await writeChannelReadiness(payload);

  assert.equal(written.deploymentId, getCurrentDeploymentId());
  assert.equal(written.ready, true);
  assert.equal(written.mode, "destructive");
  assert.equal(written.wakeFromSleepPassed, true);
  assert.equal(written.failingPhaseId, null);
  assert.equal(written.phases.length, 6);
  assert.ok(written.verifiedAt);

  const read = await readChannelReadiness();
  assert.deepEqual(read, written);
});

// ---------------------------------------------------------------------------
// Deployment ID invalidation
// ---------------------------------------------------------------------------

test("readChannelReadiness returns ready=false when stored deploymentId differs from getCurrentDeploymentId", async () => {
  // Write readiness with the current deployment
  const payload = makeDestructivePayload();
  await writeChannelReadiness(payload);

  // Simulate a new deployment by changing the env
  process.env.VERCEL_DEPLOYMENT_ID = "new-deployment-xyz";

  const read = await readChannelReadiness();
  assert.equal(read.ready, false);
  assert.equal(read.deploymentId, "new-deployment-xyz");
  assert.equal(read.verifiedAt, null);
  assert.equal(read.phases.length, 0);
});

// ---------------------------------------------------------------------------
// isChannelReady — failure cases
// ---------------------------------------------------------------------------

test("isChannelReady returns false when any required phase is not pass", () => {
  const phases = makeAllPassPhases();
  phases[2] = { id: "ensureRunning", status: "fail", durationMs: 10, message: "failed", error: "timeout" };

  const payload = makeDestructivePayload({ phases, ok: false });
  assert.equal(isChannelReady(payload), false);
});

test("isChannelReady returns false when a required phase is skipped", () => {
  const phases = makeAllPassPhases();
  phases[4] = { id: "wakeFromSleep", status: "skip", durationMs: 0, message: "skipped" };

  const payload = makeDestructivePayload({ phases });
  assert.equal(isChannelReady(payload), false);
});

test("isChannelReady returns false for safe mode even if all phases pass", () => {
  const payload = makeSafePayload({
    phases: makeAllPassPhases(),
  });
  assert.equal(isChannelReady(payload), false);
});

// ---------------------------------------------------------------------------
// isChannelReady — success case
// ---------------------------------------------------------------------------

test("isChannelReady returns false when restorePrepared phase fails", () => {
  const phases = makeAllPassPhases();
  phases[5] = { id: "restorePrepared", status: "fail", durationMs: 10, message: "restore target stale", error: "not reusable" };

  const payload = makeDestructivePayload({ phases, ok: false });
  assert.equal(isChannelReady(payload), false);
});

test("isChannelReady returns true only for destructive mode with all 6 required phases passing", () => {
  const payload = makeDestructivePayload();
  assert.equal(isChannelReady(payload), true);
});

// ---------------------------------------------------------------------------
// writeChannelReadiness persists failure state correctly
// ---------------------------------------------------------------------------

test("writeChannelReadiness records failing phase when a phase fails", async () => {
  const phases = makeAllPassPhases();
  phases[1] = { id: "queuePing", status: "fail", durationMs: 10, message: "failed", error: "timeout" };

  const payload = makeDestructivePayload({ phases, ok: false });
  const readiness = await writeChannelReadiness(payload);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.failingPhaseId, "queuePing");
  assert.equal(readiness.wakeFromSleepPassed, true);
});

test("writeChannelReadiness records wakeFromSleepPassed=false when wake phase fails", async () => {
  const phases = makeAllPassPhases();
  phases[4] = { id: "wakeFromSleep", status: "fail", durationMs: 10, message: "failed", error: "timeout" };

  const payload = makeDestructivePayload({ phases, ok: false });
  const readiness = await writeChannelReadiness(payload);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.wakeFromSleepPassed, false);
  assert.equal(readiness.failingPhaseId, "wakeFromSleep");
});

// ---------------------------------------------------------------------------
// getCurrentDeploymentId
// ---------------------------------------------------------------------------

test("getCurrentDeploymentId uses VERCEL_DEPLOYMENT_ID when set", () => {
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_abc123";
  assert.equal(getCurrentDeploymentId(), "dpl_abc123");
});

test("getCurrentDeploymentId falls back to VERCEL_GIT_COMMIT_SHA", () => {
  delete process.env.VERCEL_DEPLOYMENT_ID;
  process.env.VERCEL_GIT_COMMIT_SHA = "abc123sha";
  assert.equal(getCurrentDeploymentId(), "abc123sha");
});

test("getCurrentDeploymentId returns deterministic local fallback", () => {
  delete process.env.VERCEL_DEPLOYMENT_ID;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  const id = getCurrentDeploymentId();
  assert.ok(id.startsWith("local-"));
  // Deterministic: same value on repeated calls
  assert.equal(getCurrentDeploymentId(), id);
});

// ---------------------------------------------------------------------------
// restorePrepared readiness gating
// ---------------------------------------------------------------------------

test("isChannelReady returns false when restorePrepared phase is skipped (safe-mode shape)", () => {
  const phases: LaunchVerificationPhase[] = [
    { id: "preflight", status: "pass", durationMs: 10, message: "ok" },
    { id: "queuePing", status: "pass", durationMs: 10, message: "ok" },
    { id: "ensureRunning", status: "pass", durationMs: 10, message: "ok" },
    { id: "chatCompletions", status: "pass", durationMs: 10, message: "ok" },
    { id: "wakeFromSleep", status: "pass", durationMs: 10, message: "ok" },
    { id: "restorePrepared", status: "skip", durationMs: 0, message: "Not run in safe mode." },
  ];

  const payload = makeDestructivePayload({ phases });
  assert.equal(isChannelReady(payload), false);
});

test("isChannelReady returns false when restorePrepared phase is missing entirely", () => {
  const phases: LaunchVerificationPhase[] = [
    { id: "preflight", status: "pass", durationMs: 10, message: "ok" },
    { id: "queuePing", status: "pass", durationMs: 10, message: "ok" },
    { id: "ensureRunning", status: "pass", durationMs: 10, message: "ok" },
    { id: "chatCompletions", status: "pass", durationMs: 10, message: "ok" },
    { id: "wakeFromSleep", status: "pass", durationMs: 10, message: "ok" },
  ];

  const payload = makeDestructivePayload({ phases });
  assert.equal(isChannelReady(payload), false);
});

test("writeChannelReadiness records failingPhaseId=restorePrepared when restorePrepared fails", async () => {
  const phases = makeAllPassPhases();
  phases[5] = { id: "restorePrepared", status: "fail", durationMs: 10, message: "restore target stale", error: "not reusable" };

  const payload = makeDestructivePayload({ phases, ok: false });
  const readiness = await writeChannelReadiness(payload);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.failingPhaseId, "restorePrepared");
  assert.equal(readiness.wakeFromSleepPassed, true);
});

// ---------------------------------------------------------------------------
// Safe mode payload through writeChannelReadiness
// ---------------------------------------------------------------------------

test("writeChannelReadiness marks ready=false for safe mode payload", async () => {
  const payload = makeSafePayload();
  const readiness = await writeChannelReadiness(payload);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.mode, "safe");
});

test("buildLaunchVerifyQueueAckMessage includes queue timing baseline", () => {
  const message = buildLaunchVerifyQueueAckMessage({
    queueDelayMs: 24,
    totalMs: 24,
  });

  assert.equal(
    message,
    "Queue callback executed successfully (queue delay 24ms, total 24ms).",
  );
});

test("buildLaunchVerifyQueueSuccessMessage includes wake and completion timings", () => {
  const message = buildLaunchVerifyQueueSuccessMessage({
    queueDelayMs: 42,
    sandboxReadyMs: 1800,
    completionMs: 320,
    totalMs: 2162,
  });

  assert.equal(
    message,
    "Queue callback completed sandbox wake and chat round-trip (queue delay 42ms, sandbox ready 1800ms, completion 320ms, total 2162ms).",
  );
});

test("buildLaunchVerifyQueueFailureMessage identifies the failing stage", () => {
  const message = buildLaunchVerifyQueueFailureMessage({
    stage: "chat-completion",
    timings: {
      queueDelayMs: 50,
      sandboxReadyMs: 1400,
      completionMs: 90000,
      totalMs: 91450,
    },
  });

  assert.equal(
    message,
    "Queue callback failed during chat completion (queue delay 50ms, sandbox ready 1400ms, completion 90000ms, total 91450ms).",
  );
});
