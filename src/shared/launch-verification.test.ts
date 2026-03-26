import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildRestorePreparedPhaseEvidence,
  resolveRestorePreparedPhase,
  type RestoreTargetAttestation,
  type RestoreTargetPlan,
} from "@/shared/launch-verification";

function makeAttestation(
  overrides: Partial<RestoreTargetAttestation> = {},
): RestoreTargetAttestation {
  return {
    desiredDynamicConfigHash: "desired-config",
    desiredAssetSha256: "desired-assets",
    snapshotDynamicConfigHash: "snapshot-config",
    runtimeDynamicConfigHash: "runtime-config",
    snapshotAssetSha256: "snapshot-assets",
    runtimeAssetSha256: "runtime-assets",
    restorePreparedStatus: "dirty",
    restorePreparedReason: "dynamic-config-changed",
    restorePreparedAt: null,
    runtimeConfigFresh: false,
    snapshotConfigFresh: false,
    runtimeAssetsFresh: false,
    snapshotAssetsFresh: false,
    reusable: false,
    needsPrepare: true,
    reasons: [
      "runtime-config-stale",
      "snapshot-config-stale",
      "snapshot-assets-stale",
      "restore-target-dirty",
    ],
    ...overrides,
  };
}

function makePlan(overrides: Partial<RestoreTargetPlan> = {}): RestoreTargetPlan {
  return {
    schemaVersion: 1,
    status: "needs-prepare",
    blocking: true,
    reasons: ["restore-target-dirty"],
    actions: [
      {
        id: "prepare-destructive",
        priority: "required",
        title: "Prepare a fresh restore target",
        description: "The current snapshot cannot be reused: restore-target-dirty.",
        request: {
          method: "POST",
          path: "/api/admin/prepare-restore",
          body: { destructive: true },
        },
      },
    ],
    ...overrides,
  };
}

describe("resolveRestorePreparedPhase", () => {
  test("returns already-reusable when initial attestation is reusable", () => {
    const reusable = makeAttestation({
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
      runtimeConfigFresh: true,
      snapshotConfigFresh: true,
      runtimeAssetsFresh: true,
      snapshotAssetsFresh: true,
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });

    assert.deepEqual(
      resolveRestorePreparedPhase({
        blockedReason: "already-ready",
        initialAttestation: reusable,
        finalAttestation: reusable,
        prepare: null,
      }),
      {
        ok: true,
        code: "already-reusable",
        message: "Restore target already reusable.",
      },
    );
  });

  test("returns prepared when final attestation becomes reusable with snapshot", () => {
    const initial = makeAttestation();
    const final = makeAttestation({
      restorePreparedStatus: "ready",
      restorePreparedReason: "prepared",
      runtimeConfigFresh: true,
      snapshotConfigFresh: true,
      runtimeAssetsFresh: true,
      snapshotAssetsFresh: true,
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });

    assert.deepEqual(
      resolveRestorePreparedPhase({
        blockedReason: null,
        initialAttestation: initial,
        finalAttestation: final,
        prepare: {
          ok: true,
          snapshotId: "snap_123",
          actions: [{ status: "completed", message: "snapshot created" }],
        },
      }),
      {
        ok: true,
        code: "prepared",
        message: "Prepared fresh restore target snap_123.",
      },
    );
  });

  test("returns prepared without snapshot ID when none provided", () => {
    const initial = makeAttestation();
    const final = makeAttestation({
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });

    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: initial,
      finalAttestation: final,
      prepare: {
        ok: true,
        snapshotId: null,
        actions: [{ status: "completed", message: "done" }],
      },
    });

    assert.equal(result.code, "prepared");
    assert.equal(result.message, "Prepared fresh restore target.");
  });

  test("returns not-reusable-after-prepare when final attestation is still not reusable and prepare succeeded", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation({
        reasons: ["snapshot-config-stale", "restore-target-failed"],
      }),
      prepare: {
        ok: true,
        snapshotId: "snap_123",
        actions: [{ status: "completed", message: "snapshot created" }],
      },
    });

    assert.deepEqual(result, {
      ok: false,
      code: "not-reusable-after-prepare",
      message: "Restore target is still not reusable after destructive prepare.",
    });
  });

  test("returns prepare-failed when prepare.ok is false", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation({
        reasons: ["restore-target-failed"],
      }),
      prepare: {
        ok: false,
        snapshotId: null,
        actions: [{ status: "failed", message: "gateway not ready" }],
      },
    });

    assert.deepEqual(result, {
      ok: false,
      code: "prepare-failed",
      message: "gateway not ready",
    });
  });

  test("returns prepare-failed with default message when no failed action", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: null,
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation(),
      prepare: {
        ok: false,
        snapshotId: null,
        actions: [{ status: "skipped", message: "skipped" }],
      },
    });

    assert.equal(result.code, "prepare-failed");
    assert.equal(result.message, "Restore preparation failed.");
  });

  test("returns blocked when blockedReason is present and no prepare ran", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: "sandbox-not-running",
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation(),
      prepare: null,
    });

    assert.deepEqual(result, {
      ok: false,
      code: "blocked",
      message: "Sandbox is not running; destructive prepare skipped.",
    });
  });

  test("returns blocked with formatted message for known reasons", () => {
    const knownReasons: Array<{ reason: string; expected: string }> = [
      { reason: "already-ready", expected: "Restore target already reusable." },
      { reason: "already-running", expected: "Restore oracle already running in another worker." },
      { reason: "sandbox-recently-active", expected: "Sandbox was recently active; destructive prepare skipped." },
      { reason: "gateway-not-ready", expected: "Gateway is not healthy enough to seal a fresh restore target." },
    ];

    for (const { reason, expected } of knownReasons) {
      const result = resolveRestorePreparedPhase({
        blockedReason: reason,
        initialAttestation: makeAttestation(),
        finalAttestation: makeAttestation(),
        prepare: null,
      });
      assert.equal(result.code, "blocked");
      assert.equal(result.message, expected, `blocked message for ${reason}`);
    }
  });

  test("returns blocked with generic message for unknown reasons", () => {
    const result = resolveRestorePreparedPhase({
      blockedReason: "custom-reason",
      initialAttestation: makeAttestation(),
      finalAttestation: makeAttestation(),
      prepare: null,
    });

    assert.equal(result.code, "blocked");
    assert.equal(result.message, "Restore prepare blocked: custom-reason.");
  });
});

describe("buildRestorePreparedPhaseEvidence", () => {
  test("returns bounded evidence with kind and resolution", () => {
    const initial = makeAttestation();
    const final = makeAttestation();
    const plan = makePlan();

    const evidence = buildRestorePreparedPhaseEvidence({
      blockedReason: "sandbox-not-running",
      initialAttestation: initial,
      finalAttestation: final,
      plan,
      prepare: null,
    });

    assert.equal(evidence.kind, "restorePrepared");
    assert.equal(evidence.resolution.code, "blocked");
    assert.equal(evidence.resolution.ok, false);
    assert.equal(evidence.blockedReason, "sandbox-not-running");
    assert.deepEqual(evidence.initialAttestation, initial);
    assert.deepEqual(evidence.finalAttestation, final);
    assert.deepEqual(evidence.plan, plan);
    assert.equal(evidence.prepare, null);
  });

  test("includes prepare actions when present", () => {
    const initial = makeAttestation();
    const final = makeAttestation({
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });
    const plan = makePlan({ status: "ready", blocking: false, actions: [] });
    const prepare = {
      ok: true,
      snapshotId: "snap_456",
      actions: [
        { status: "completed" as const, message: "config synced" },
        { status: "completed" as const, message: "snapshot taken" },
      ],
    };

    const evidence = buildRestorePreparedPhaseEvidence({
      blockedReason: null,
      initialAttestation: initial,
      finalAttestation: final,
      plan,
      prepare,
    });

    assert.equal(evidence.resolution.code, "prepared");
    assert.equal(evidence.resolution.ok, true);
    assert.deepEqual(evidence.prepare, prepare);
    assert.equal(evidence.blockedReason, null);
  });

  test("resolution reflects already-reusable when initial is reusable", () => {
    const reusable = makeAttestation({
      reusable: true,
      needsPrepare: false,
      reasons: [],
    });
    const plan = makePlan({ status: "ready", blocking: false, actions: [] });

    const evidence = buildRestorePreparedPhaseEvidence({
      blockedReason: "already-ready",
      initialAttestation: reusable,
      finalAttestation: reusable,
      plan,
      prepare: null,
    });

    assert.equal(evidence.resolution.code, "already-reusable");
    assert.equal(evidence.resolution.ok, true);
  });
});
