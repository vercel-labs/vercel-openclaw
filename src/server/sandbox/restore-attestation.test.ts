import assert from "node:assert/strict";
import test from "node:test";

import {
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
} from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import {
  buildRestoreDecision,
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import type { RestoreTargetAttestation } from "@/shared/launch-verification";
import { createDefaultMeta } from "@/shared/types";

test("buildRestoreTargetAttestation includes whatsapp config in desiredDynamicConfigHash", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
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

  const meta = {
    ...base,
    channels: {
      ...base.channels,
      whatsapp,
    },
  };

  const attestation = buildRestoreTargetAttestation(meta);
  const withWhatsapp = computeGatewayConfigHash({
    whatsappConfig: toWhatsAppGatewayConfig(whatsapp),
  });
  const withoutWhatsapp = computeGatewayConfigHash({});

  assert.equal(attestation.desiredDynamicConfigHash, withWhatsapp);
  assert.notEqual(attestation.desiredDynamicConfigHash, withoutWhatsapp);
});

test("buildRestoreTargetAttestation separates runtime-fresh from snapshot-stale", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-stale",
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotDynamicConfigHash: "stale-snapshot-hash",
    runtimeAssetSha256: desiredAssetSha256,
    snapshotAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "dirty",
    restorePreparedReason: "dynamic-config-changed",
    restorePreparedAt: 123,
  });

  assert.equal(attestation.runtimeConfigFresh, true);
  assert.equal(attestation.snapshotConfigFresh, false);
  assert.equal(attestation.runtimeAssetsFresh, true);
  assert.equal(attestation.snapshotAssetsFresh, true);
  assert.equal(attestation.reusable, false);
  assert.equal(attestation.needsPrepare, true);
  assert.deepEqual(attestation.reasons, [
    "snapshot-config-stale",
    "restore-target-dirty",
  ]);
});

test("buildRestoreTargetAttestation returns null freshness when hash is absent", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-no-hashes",
    runtimeDynamicConfigHash: null,
    snapshotDynamicConfigHash: null,
    runtimeAssetSha256: null,
    snapshotAssetSha256: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    restorePreparedAt: null,
  });

  assert.equal(attestation.runtimeConfigFresh, null);
  assert.equal(attestation.snapshotConfigFresh, null);
  assert.equal(attestation.runtimeAssetsFresh, null);
  assert.equal(attestation.snapshotAssetsFresh, null);
  assert.equal(attestation.reusable, false);
  assert.equal(attestation.needsPrepare, true);
  assert.ok(attestation.reasons.includes("snapshot-config-unknown"));
  assert.ok(attestation.reasons.includes("snapshot-assets-unknown"));
  assert.ok(attestation.reasons.includes("restore-target-unknown"));
});

test("buildRestoreTargetAttestation reports reusable when snapshot is fresh and ready", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-ready",
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready",
    restorePreparedReason: "prepared",
    restorePreparedAt: Date.now(),
  });

  assert.equal(attestation.reusable, true);
  assert.equal(attestation.needsPrepare, false);
  assert.deepEqual(attestation.reasons, []);
});

test("buildRestoreTargetAttestation marks stale snapshot hashes (config + assets) as non-reusable", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-stale-hashes",
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotDynamicConfigHash: "old-snapshot-config-hash",
    runtimeAssetSha256: desiredAssetSha256,
    snapshotAssetSha256: "old-snapshot-asset-sha256",
    restorePreparedStatus: "dirty",
    restorePreparedReason: "static-assets-changed",
    restorePreparedAt: 1,
  });

  assert.equal(attestation.reusable, false);
  assert.equal(attestation.needsPrepare, true);
  assert.equal(attestation.snapshotConfigFresh, false);
  assert.equal(attestation.snapshotAssetsFresh, false);
  assert.equal(attestation.runtimeConfigFresh, true);
  assert.equal(attestation.runtimeAssetsFresh, true);
  assert.ok(attestation.reasons.includes("snapshot-config-stale"));
  assert.ok(attestation.reasons.includes("snapshot-assets-stale"));
  assert.ok(attestation.reasons.includes("restore-target-dirty"));
});

test("buildRestoreTargetAttestation: missing snapshotId is never reusable even when hashes match", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: null,
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready",
    restorePreparedReason: "prepared",
    restorePreparedAt: 123,
  });

  assert.equal(attestation.reusable, false);
  assert.equal(attestation.needsPrepare, true);
  assert.ok(attestation.reasons.includes("snapshot-missing"));
});

test("buildRestoreTargetAttestation: present snapshotId with matching hashes is reusable", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-ready",
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready",
    restorePreparedReason: "prepared",
    restorePreparedAt: Date.now(),
  });

  assert.equal(attestation.reusable, true);
  assert.equal(attestation.needsPrepare, false);
  assert.ok(!attestation.reasons.includes("snapshot-missing"));
});

// ---------------------------------------------------------------------------
// buildRestoreTargetPlan tests
// ---------------------------------------------------------------------------

function makeAttestation(
  overrides: Partial<RestoreTargetAttestation> = {},
): RestoreTargetAttestation {
  return {
    desiredDynamicConfigHash: "cfg-current",
    desiredAssetSha256: "asset-current",
    snapshotDynamicConfigHash: "cfg-current",
    runtimeDynamicConfigHash: "cfg-current",
    snapshotAssetSha256: "asset-current",
    runtimeAssetSha256: "asset-current",
    restorePreparedStatus: "ready",
    restorePreparedReason: "prepared",
    restorePreparedAt: 123,
    runtimeConfigFresh: true,
    snapshotConfigFresh: true,
    runtimeAssetsFresh: true,
    snapshotAssetsFresh: true,
    reusable: true,
    needsPrepare: false,
    reasons: [],
    ...overrides,
  };
}

test("buildRestoreTargetPlan returns ready when snapshot is reusable", () => {
  assert.deepEqual(
    buildRestoreTargetPlan({
      attestation: makeAttestation(),
      status: "stopped",
      sandboxId: null,
    }),
    {
      schemaVersion: 1,
      status: "ready",
      blocking: false,
      reasons: [],
      actions: [],
    },
  );
});

test("buildRestoreTargetPlan requires ensure-running before destructive prepare", () => {
  const attestation = makeAttestation({
    snapshotDynamicConfigHash: "cfg-old",
    snapshotConfigFresh: false,
    reusable: false,
    needsPrepare: true,
    reasons: ["snapshot-config-stale"],
  });

  assert.deepEqual(
    buildRestoreTargetPlan({
      attestation,
      status: "stopped",
      sandboxId: null,
    }),
    {
      schemaVersion: 1,
      status: "needs-prepare",
      blocking: true,
      reasons: ["snapshot-config-stale"],
      actions: [
        {
          id: "ensure-running",
          priority: "required",
          title: "Start the sandbox",
          description:
            "Destructive restore preparation needs a running sandbox.",
          request: {
            method: "POST",
            path: "/api/admin/ensure?wait=1",
            body: null,
          },
        },
        {
          id: "prepare-destructive",
          priority: "required",
          title: "Prepare a fresh restore target",
          description:
            "The current snapshot cannot be reused: snapshot-config-stale.",
          request: {
            method: "POST",
            path: "/api/admin/prepare-restore",
            body: { destructive: true },
          },
        },
      ],
    },
  );
});

// ---------------------------------------------------------------------------
// buildRestoreDecision tests
// ---------------------------------------------------------------------------

test("buildRestoreDecision: snapshotId missing with matching hashes and ready status yields non-reusable with snapshot-missing reason", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  const meta = {
    ...base,
    snapshotId: null,
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready" as const,
    restorePreparedReason: "prepared" as const,
    restorePreparedAt: 123,
    status: "stopped" as const,
    sandboxId: null,
  };

  const decision = buildRestoreDecision({
    meta,
    source: "inspect",
    destructive: false,
  });

  assert.equal(decision.reusable, false);
  assert.equal(decision.needsPrepare, true);
  assert.ok(decision.reasons.includes("snapshot-missing"));
  assert.deepEqual(decision.requiredActions, [
    "ensure-running",
    "prepare-destructive",
  ]);
  assert.equal(decision.nextAction, "ensure-running");
});

// ---------------------------------------------------------------------------
// Q31: Legacy snapshotConfigHash fallback — exercised only via partial meta
// ---------------------------------------------------------------------------

test("Q31: buildRestoreTargetAttestation falls back to legacy snapshotConfigHash", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  // Direct call into buildRestoreTargetAttestation with a raw meta that
  // ONLY has the legacy snapshotConfigHash (snapshotDynamicConfigHash is null).
  // This path is only reachable when callers bypass ensureMetaShape — which
  // rewrites legacy → dynamic on hydration. For meta already hydrated via the
  // store, snapshotDynamicConfigHash will be populated and the fallback is
  // effectively dead.
  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-legacy",
    snapshotDynamicConfigHash: null,
    snapshotConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready",
    restorePreparedReason: "prepared",
    restorePreparedAt: Date.now(),
  });

  // Legacy hash promotes through fallback to snapshotConfigFresh=true.
  assert.equal(attestation.snapshotConfigFresh, true);
  assert.equal(attestation.snapshotDynamicConfigHash, desiredConfigHash);
  assert.equal(attestation.reusable, true);
});

test("Q31: legacy snapshotConfigHash fallback not reused after hydration", async () => {
  // After ensureMetaShape, snapshotConfigHash is copied to snapshotDynamicConfigHash.
  // So in the hydrated path, the fallback branch in buildRestoreTargetAttestation
  // at line 55-56 never activates. Verify by hydrating a legacy meta.
  const { ensureMetaShape } = await import("@/shared/types");
  const legacy = {
    id: "openclaw-single",
    gatewayToken: "tok",
    snapshotConfigHash: "legacy-hash",
    snapshotDynamicConfigHash: null,
  };
  const hydrated = ensureMetaShape(legacy, "openclaw-single");
  assert.ok(hydrated);
  // After hydration, both fields are set to legacy-hash — the fallback is
  // redundant for any hydrated meta.
  assert.equal(hydrated.snapshotDynamicConfigHash, "legacy-hash");
  assert.equal(hydrated.snapshotConfigHash, "legacy-hash");
});

// ---------------------------------------------------------------------------
// Q32: restore-target-dirty + snapshot-config-stale co-occur
// ---------------------------------------------------------------------------

test("Q32: restore-target-dirty and snapshot-config-stale appear together when config changes", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  // Config changed → snapshot config hash is stale AND restore-prepared=dirty.
  // Both reasons surface together — they describe the same underlying event
  // (config changed after last prepare), but from different vantage points:
  //   - snapshot-config-stale: attestation of the snapshot image contents
  //   - restore-target-dirty: pre-verified flag set when config changed
  const decision = buildRestoreDecision({
    meta: {
      ...base,
      status: "running",
      sandboxId: "sbx-1",
      snapshotId: "snap-dirty",
      snapshotDynamicConfigHash: "old-hash",
      runtimeDynamicConfigHash: desiredConfigHash,
      snapshotAssetSha256: desiredAssetSha256,
      runtimeAssetSha256: desiredAssetSha256,
      restorePreparedStatus: "dirty",
      restorePreparedReason: "dynamic-config-changed",
      restorePreparedAt: Date.now(),
    },
    source: "inspect",
    destructive: false,
  });

  assert.ok(decision.reasons.includes("snapshot-config-stale"));
  assert.ok(decision.reasons.includes("restore-target-dirty"));

  // Confirmation: they always co-occur when restorePreparedReason is the one
  // that caused snapshot drift. The redundancy is intentional — it gives
  // operators two signals (runtime-observed + pre-flagged) that agree.
});

test("Q32: restore-target-dirty can occur without snapshot-config-stale", () => {
  // If restorePreparedStatus is "dirty" for a non-config reason (e.g. assets
  // changed), snapshot-config-stale is NOT added but restore-target-dirty IS.
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-assets-dirty",
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: "old-asset-sha",
    runtimeAssetSha256: buildRestoreAssetManifest().sha256,
    restorePreparedStatus: "dirty",
    restorePreparedReason: "static-assets-changed",
    restorePreparedAt: 1,
  });

  assert.ok(!attestation.reasons.includes("snapshot-config-stale"));
  assert.ok(attestation.reasons.includes("snapshot-assets-stale"));
  assert.ok(attestation.reasons.includes("restore-target-dirty"));
});

// ---------------------------------------------------------------------------
// Q35: Legacy snapshot with no hashes is flagged as unknown / not reusable
// ---------------------------------------------------------------------------

test("Q35: legacy snapshot with all hashes null is non-reusable with unknown reasons", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");

  const attestation = buildRestoreTargetAttestation({
    ...base,
    snapshotId: "snap-legacy-no-hashes",
    snapshotDynamicConfigHash: null,
    runtimeDynamicConfigHash: null,
    snapshotAssetSha256: null,
    runtimeAssetSha256: null,
    restorePreparedStatus: "unknown",
    restorePreparedReason: null,
    restorePreparedAt: null,
  });

  assert.equal(attestation.reusable, false);
  assert.equal(attestation.needsPrepare, true);
  assert.ok(attestation.reasons.includes("snapshot-config-unknown"));
  assert.ok(attestation.reasons.includes("snapshot-assets-unknown"));
  assert.ok(attestation.reasons.includes("restore-target-unknown"));
  assert.equal(attestation.snapshotConfigFresh, null);
  assert.equal(attestation.snapshotAssetsFresh, null);
});

test("buildRestoreDecision agrees with attestation.reusable and plan.actions for same input", () => {
  const base = createDefaultMeta(Date.now(), "gw-token");
  const desiredConfigHash = computeGatewayConfigHash({});
  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;

  // Test case 1: reusable snapshot
  const reusableMeta = {
    ...base,
    snapshotId: "snap-ready",
    snapshotDynamicConfigHash: desiredConfigHash,
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "ready" as const,
    restorePreparedReason: "prepared" as const,
    restorePreparedAt: Date.now(),
    status: "running" as const,
    sandboxId: "sbx-1",
  };

  const reusableDecision = buildRestoreDecision({
    meta: reusableMeta,
    source: "inspect",
    destructive: false,
  });
  const reusableAttestation = buildRestoreTargetAttestation(reusableMeta);
  const reusablePlan = buildRestoreTargetPlan({
    attestation: reusableAttestation,
    status: reusableMeta.status,
    sandboxId: reusableMeta.sandboxId,
  });

  assert.equal(reusableDecision.reusable, reusableAttestation.reusable);
  assert.deepEqual(
    reusableDecision.requiredActions,
    reusablePlan.actions
      .map((a) => a.id)
      .filter(
        (id) => id === "ensure-running" || id === "prepare-destructive",
      ),
  );

  // Test case 2: non-reusable snapshot (stopped, no sandbox)
  const dirtyMeta = {
    ...base,
    snapshotId: "snap-stale",
    snapshotDynamicConfigHash: "old-hash",
    runtimeDynamicConfigHash: desiredConfigHash,
    snapshotAssetSha256: desiredAssetSha256,
    runtimeAssetSha256: desiredAssetSha256,
    restorePreparedStatus: "dirty" as const,
    restorePreparedReason: "dynamic-config-changed" as const,
    restorePreparedAt: 1,
    status: "stopped" as const,
    sandboxId: null,
  };

  const dirtyDecision = buildRestoreDecision({
    meta: dirtyMeta,
    source: "inspect",
    destructive: false,
  });
  const dirtyAttestation = buildRestoreTargetAttestation(dirtyMeta);
  const dirtyPlan = buildRestoreTargetPlan({
    attestation: dirtyAttestation,
    status: dirtyMeta.status,
    sandboxId: dirtyMeta.sandboxId,
  });

  assert.equal(dirtyDecision.reusable, dirtyAttestation.reusable);
  assert.deepEqual(
    dirtyDecision.requiredActions,
    dirtyPlan.actions
      .map((a) => a.id)
      .filter(
        (id) => id === "ensure-running" || id === "prepare-destructive",
      ),
  );
});
