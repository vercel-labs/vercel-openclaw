import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createDefaultMeta,
  ensureMetaShape,
  ensureRestoreOracleState,
  type RestoreOracleState,
} from "@/shared/types";

// ---------------------------------------------------------------------------
// ensureRestoreOracleState unit tests
// ---------------------------------------------------------------------------

describe("ensureRestoreOracleState", () => {
  test("returns idle defaults for undefined input", () => {
    const result = ensureRestoreOracleState(undefined);
    assert.deepStrictEqual(result, {
      status: "idle",
      pendingReason: null,
      lastEvaluatedAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastBlockedReason: null,
      lastError: null,
      consecutiveFailures: 0,
      lastResult: null,
    });
  });

  test("returns idle defaults for null input", () => {
    const result = ensureRestoreOracleState(null);
    assert.equal(result.status, "idle");
    assert.equal(result.consecutiveFailures, 0);
  });

  test("returns idle defaults for non-object input", () => {
    const result = ensureRestoreOracleState("garbage");
    assert.equal(result.status, "idle");
  });

  test("preserves valid fields from partial input", () => {
    const result = ensureRestoreOracleState({
      status: "pending",
      pendingReason: "dynamic-config-changed",
      consecutiveFailures: 3,
      lastResult: "failed",
    });
    assert.equal(result.status, "pending");
    assert.equal(result.pendingReason, "dynamic-config-changed");
    assert.equal(result.consecutiveFailures, 3);
    assert.equal(result.lastResult, "failed");
    // Non-provided fields fall to defaults
    assert.equal(result.lastEvaluatedAt, null);
    assert.equal(result.lastError, null);
  });

  test("rejects invalid status values", () => {
    const result = ensureRestoreOracleState({ status: "bogus" });
    assert.equal(result.status, "idle");
  });

  test("rejects invalid pendingReason values", () => {
    const result = ensureRestoreOracleState({ pendingReason: "not-a-reason" });
    assert.equal(result.pendingReason, null);
  });

  test("rejects invalid lastResult values", () => {
    const result = ensureRestoreOracleState({ lastResult: "nope" });
    assert.equal(result.lastResult, null);
  });

  test("preserves all valid RestoreOracleLastResult values", () => {
    for (const value of ["already-ready", "prepared", "blocked", "failed"] as const) {
      const result = ensureRestoreOracleState({ lastResult: value });
      assert.equal(result.lastResult, value, `lastResult should accept "${value}"`);
    }
  });

  test("preserves all valid RestoreOracleStatus values", () => {
    for (const value of ["idle", "pending", "running", "blocked", "failed", "ready"] as const) {
      const result = ensureRestoreOracleState({ status: value });
      assert.equal(result.status, value, `status should accept "${value}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// createDefaultMeta includes restoreOracle
// ---------------------------------------------------------------------------

describe("createDefaultMeta restoreOracle", () => {
  test("returns restoreOracle with idle defaults", () => {
    const meta = createDefaultMeta(Date.now(), "test-token");
    assert.equal(meta.restoreOracle.status, "idle");
    assert.equal(meta.restoreOracle.pendingReason, null);
    assert.equal(meta.restoreOracle.consecutiveFailures, 0);
    assert.equal(meta.restoreOracle.lastResult, null);
    assert.equal(meta.restoreOracle.lastEvaluatedAt, null);
    assert.equal(meta.restoreOracle.lastStartedAt, null);
    assert.equal(meta.restoreOracle.lastCompletedAt, null);
    assert.equal(meta.restoreOracle.lastBlockedReason, null);
    assert.equal(meta.restoreOracle.lastError, null);
  });
});

// ---------------------------------------------------------------------------
// ensureMetaShape legacy hydration — restoreOracle
// ---------------------------------------------------------------------------

describe("ensureMetaShape restoreOracle hydration", () => {
  test("hydrates legacy meta without restoreOracle field to idle defaults", () => {
    const legacyMeta = {
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      // restoreOracle field is absent — simulates pre-oracle persisted meta
    };

    const result = ensureMetaShape(legacyMeta);
    assert.ok(result, "ensureMetaShape should return non-null for valid legacy meta");
    assert.equal(result.restoreOracle.status, "idle");
    assert.equal(result.restoreOracle.pendingReason, null);
    assert.equal(result.restoreOracle.consecutiveFailures, 0);
    assert.equal(result.restoreOracle.lastResult, null);
  });

  test("preserves existing restoreOracle state through hydration", () => {
    const existingOracle: RestoreOracleState = {
      status: "pending",
      pendingReason: "dynamic-config-changed",
      lastEvaluatedAt: 1000,
      lastStartedAt: 900,
      lastCompletedAt: 950,
      lastBlockedReason: "Sandbox was active",
      lastError: null,
      consecutiveFailures: 1,
      lastResult: "blocked",
    };

    const meta = {
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      restoreOracle: existingOracle,
    };

    const result = ensureMetaShape(meta);
    assert.ok(result);
    assert.deepStrictEqual(result.restoreOracle, existingOracle);
  });

  test("repairs corrupted restoreOracle gracefully", () => {
    const meta = {
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "running",
      restoreOracle: {
        status: "INVALID",
        pendingReason: 12345,
        consecutiveFailures: "not-a-number",
        lastResult: "bogus",
      },
    };

    const result = ensureMetaShape(meta);
    assert.ok(result);
    assert.equal(result.restoreOracle.status, "idle");
    assert.equal(result.restoreOracle.pendingReason, null);
    assert.equal(result.restoreOracle.consecutiveFailures, 0);
    assert.equal(result.restoreOracle.lastResult, null);
  });

  test("backward compatible with old meta that only has snapshotConfigHash", () => {
    const legacyMeta = {
      id: "openclaw-single",
      version: 1,
      gatewayToken: "gw",
      status: "stopped",
      snapshotConfigHash: "abc123",
      // No snapshotDynamicConfigHash, no runtimeDynamicConfigHash, no restoreOracle
    };

    const result = ensureMetaShape(legacyMeta);
    assert.ok(result);
    // Legacy snapshotConfigHash should be preserved
    assert.equal(result.snapshotConfigHash, "abc123");
    // snapshotDynamicConfigHash should fall back to snapshotConfigHash
    assert.equal(result.snapshotDynamicConfigHash, "abc123");
    // restoreOracle should hydrate to idle defaults
    assert.equal(result.restoreOracle.status, "idle");
    assert.equal(result.restoreOracle.consecutiveFailures, 0);
  });
});

// ---------------------------------------------------------------------------
// Q38: ensureMetaShape instance ID mismatch guard
// ---------------------------------------------------------------------------

describe("ensureMetaShape instance ID mismatch", () => {
  test("throws when persisted meta.id differs from expectedInstanceId", () => {
    assert.throws(
      () =>
        ensureMetaShape(
          { id: "some-other-instance", gatewayToken: "gw" },
          "openclaw-single",
        ),
      /Refusing to hydrate meta for instance "some-other-instance" while expecting "openclaw-single"/,
    );
  });

  test("accepts hydration when ids match exactly", () => {
    const result = ensureMetaShape(
      { id: "openclaw-single", gatewayToken: "gw" },
      "openclaw-single",
    );
    assert.ok(result, "should hydrate when ids match");
    assert.equal(result!.id, "openclaw-single");
  });

  test("accepts hydration when persisted id is missing (legacy meta)", () => {
    // Raw.id missing — hydrator fills in expectedInstanceId without throwing.
    const result = ensureMetaShape(
      { gatewayToken: "gw" },
      "openclaw-single",
    );
    assert.ok(result, "should hydrate legacy meta missing id");
    assert.equal(result!.id, "openclaw-single");
  });

  test("throws with both ids in the error message for operator debugging", () => {
    try {
      ensureMetaShape(
        { id: "stale-prefix", gatewayToken: "gw" },
        "new-prefix",
      );
      assert.fail("expected ensureMetaShape to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(msg.includes("stale-prefix"), `error should mention persisted id, got: ${msg}`);
      assert.ok(msg.includes("new-prefix"), `error should mention expected id, got: ${msg}`);
    }
  });
});
