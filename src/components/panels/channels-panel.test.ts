import assert from "node:assert/strict";
import test from "node:test";

import type {
  ChannelReadiness,
  LaunchVerificationPayload,
} from "@/shared/launch-verification";
import {
  getPreflightBlockerIds,
  summarizePreflight,
  formatPreflightFetchError,
  getVerificationViewModel,
  formatLaunchVerificationFetchError,
  getVerificationSurfaceState,
  createVerificationRequestId,
} from "./channels-panel";

test("getPreflightBlockerIds returns failing check IDs", () => {
  const ids = getPreflightBlockerIds({
    ok: false,
    checks: [
      { id: "store", status: "fail", message: "Durable state missing." },
      { id: "webhook-bypass", status: "warn", message: "Bypass not configured." },
      { id: "ai-gateway", status: "fail", message: "AI gateway unavailable." },
    ],
  });
  assert.deepEqual([...(ids ?? [])].sort(), ["ai-gateway", "store"]);
});

test("getPreflightBlockerIds returns null when preflight is null", () => {
  assert.equal(getPreflightBlockerIds(null), null);
});

test("getPreflightBlockerIds returns null when preflight.ok is true", () => {
  const ids = getPreflightBlockerIds({
    ok: true,
    checks: [{ id: "store", status: "fail", message: "ignored when ok" }],
  });
  assert.equal(ids, null);
});

test("summarizePreflight keeps blocker ids separate from required action ids", () => {
  const summary = summarizePreflight({
    ok: false,
    checks: [
      { id: "store", status: "fail", message: "Using in-memory state." },
      { id: "ai-gateway", status: "fail", message: "OIDC token is not available." },
    ],
    actions: [
      {
        id: "configure-upstash",
        status: "required",
        message: "Add a durable store.",
        remediation: "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
        env: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      },
      {
        id: "configure-ai-gateway-auth",
        status: "required",
        message: "Enable AI Gateway auth.",
        remediation: "Enable OIDC or set AI_GATEWAY_API_KEY.",
        env: ["AI_GATEWAY_API_KEY"],
      },
      {
        id: "set-webhook-bypass",
        status: "recommended",
        message: "Bypass is recommended.",
        remediation: "Set VERCEL_AUTOMATION_BYPASS_SECRET.",
        env: ["VERCEL_AUTOMATION_BYPASS_SECRET"],
      },
    ],
  });
  assert.deepEqual(summary.blockerIds, ["store", "ai-gateway"]);
  assert.deepEqual(summary.blockerMessages, [
    "Using in-memory state.",
    "OIDC token is not available.",
  ]);
  assert.deepEqual(summary.requiredActionIds, [
    "configure-upstash",
    "configure-ai-gateway-auth",
  ]);
  assert.deepEqual(summary.requiredRemediations, [
    "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    "Enable OIDC or set AI_GATEWAY_API_KEY.",
  ]);
});

test("summarizePreflight returns an empty summary for null input", () => {
  assert.deepEqual(summarizePreflight(null), {
    ok: null,
    blockerIds: [],
    blockerMessages: [],
    requiredActionIds: [],
    requiredRemediations: [],
  });
});

test("formatPreflightFetchError prefers an explicit error message", () => {
  assert.equal(
    formatPreflightFetchError(
      new Error("Failed to load deployment preflight: HTTP 500"),
    ),
    "Failed to load deployment preflight: HTTP 500",
  );
  assert.equal(
    formatPreflightFetchError(null),
    "Failed to load deployment preflight. Refresh the panel or open /api/admin/preflight.",
  );
});

/* ── getVerificationViewModel tests ── */

const READY_READINESS = {
  ready: true,
  verifiedAt: "2026-03-28T09:00:00.000Z",
} as Pick<ChannelReadiness, "ready" | "verifiedAt">;

test("getVerificationViewModel prioritizes running state over stale readiness", () => {
  const view = getVerificationViewModel({
    readiness: READY_READINESS,
    verifyResult: null,
    verifyRunning: true,
    totalMs: 0,
  });
  assert.equal(view.badgeText, "Verifying\u2026");
  assert.equal(view.summaryText, "Verification in progress");
  assert.equal(view.showQuickCheck, false);
});

test("getVerificationViewModel prioritizes failed result over stale verified readiness", () => {
  const view = getVerificationViewModel({
    readiness: READY_READINESS,
    verifyResult: { ok: false } as Pick<LaunchVerificationPayload, "ok">,
    verifyRunning: false,
    totalMs: 0,
  });
  assert.equal(view.badgeText, "Failed");
  assert.equal(view.summaryText, "Last verification failed");
  assert.equal(view.primaryActionLabel, "Re-verify");
});

test("getVerificationViewModel formats verified success summary", () => {
  const view = getVerificationViewModel({
    readiness: READY_READINESS,
    verifyResult: { ok: true } as Pick<LaunchVerificationPayload, "ok">,
    verifyRunning: false,
    totalMs: 1500,
  });
  assert.equal(view.badgeText, "Verified");
  assert.match(view.summaryText, /^Verified /);
  assert.match(view.summaryText, /1\.5s/);
  assert.equal(view.primaryActionLabel, "Re-verify");
});

test("getVerificationViewModel shows initial unverified state when no readiness exists", () => {
  const view = getVerificationViewModel({
    readiness: null,
    verifyResult: null,
    verifyRunning: false,
    totalMs: 0,
  });
  assert.equal(view.badgeText, "");
  assert.equal(view.summaryText, "Not yet verified");
  assert.equal(view.showQuickCheck, true);
  assert.equal(view.primaryActionLabel, "Verify");
});

test("getVerificationViewModel clears back to unverified when readiness is absent", () => {
  const view = getVerificationViewModel({
    readiness: null,
    verifyResult: null,
    verifyRunning: false,
    totalMs: 0,
  });
  assert.equal(view.badgeText, "");
  assert.equal(view.summaryText, "Not yet verified");
  assert.equal(view.primaryActionClassName, "button primary");
});

/* ── formatLaunchVerificationFetchError tests ── */

test("formatLaunchVerificationFetchError prefers explicit nested message", () => {
  assert.equal(
    formatLaunchVerificationFetchError(
      { error: { message: "Launch verify endpoint timed out" } },
      504,
    ),
    "Launch verify endpoint timed out",
  );
});

test("formatLaunchVerificationFetchError falls back to actionable default", () => {
  assert.equal(
    formatLaunchVerificationFetchError(null, 502),
    "Verification request failed (HTTP 502). Refresh the panel or open /api/admin/launch-verify.",
  );
});

test("formatLaunchVerificationFetchError prefers top-level message when nested is absent", () => {
  assert.equal(
    formatLaunchVerificationFetchError(
      { message: "Service unavailable" },
      503,
    ),
    "Service unavailable",
  );
});

/* ── getVerificationSurfaceState tests ── */

test("getVerificationSurfaceState returns running when verifyRunning is true", () => {
  assert.equal(
    getVerificationSurfaceState({
      readiness: null,
      verifyResult: null,
      verifyRunning: true,
    }),
    "running",
  );
});

test("getVerificationSurfaceState returns verified when result ok", () => {
  assert.equal(
    getVerificationSurfaceState({
      readiness: null,
      verifyResult: { ok: true } as LaunchVerificationPayload,
      verifyRunning: false,
    }),
    "verified",
  );
});

test("getVerificationSurfaceState returns failed when result not ok", () => {
  assert.equal(
    getVerificationSurfaceState({
      readiness: null,
      verifyResult: { ok: false } as LaunchVerificationPayload,
      verifyRunning: false,
    }),
    "failed",
  );
});

test("getVerificationSurfaceState returns verified from readiness when no result", () => {
  assert.equal(
    getVerificationSurfaceState({
      readiness: { ready: true } as ChannelReadiness,
      verifyResult: null,
      verifyRunning: false,
    }),
    "verified",
  );
});

test("getVerificationSurfaceState returns idle when nothing is set", () => {
  assert.equal(
    getVerificationSurfaceState({
      readiness: null,
      verifyResult: null,
      verifyRunning: false,
    }),
    "idle",
  );
});

/* ── createVerificationRequestId tests ── */

test("createVerificationRequestId returns a string starting with verify-", () => {
  const id = createVerificationRequestId();
  assert.ok(id.startsWith("verify-"), `Expected prefix "verify-", got "${id}"`);
});

test("createVerificationRequestId returns unique IDs on successive calls", () => {
  const a = createVerificationRequestId();
  const b = createVerificationRequestId();
  assert.notEqual(a, b);
});

test("createVerificationRequestId returns a non-empty suffix after verify-", () => {
  const id = createVerificationRequestId();
  const suffix = id.slice("verify-".length);
  assert.ok(suffix.length > 0, `Expected non-empty suffix, got "${suffix}"`);
});
