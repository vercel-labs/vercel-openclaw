import assert from "node:assert/strict";
import test from "node:test";

import {
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
} from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import {
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
            path: "/api/admin/restore-target",
            body: { destructive: true },
          },
        },
      ],
    },
  );
});
