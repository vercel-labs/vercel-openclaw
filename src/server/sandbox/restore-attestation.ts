import {
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
} from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import type { SingleMeta } from "@/shared/types";
import type {
  RestoreTargetAttestation,
  RestoreTargetPlan,
} from "@/shared/launch-verification";

type RestoreAttestationMeta = Pick<
  SingleMeta,
  | "channels"
  | "snapshotConfigHash"
  | "snapshotDynamicConfigHash"
  | "runtimeDynamicConfigHash"
  | "snapshotAssetSha256"
  | "runtimeAssetSha256"
  | "restorePreparedStatus"
  | "restorePreparedReason"
  | "restorePreparedAt"
>;

function compareHash(
  actual: string | null | undefined,
  expected: string,
): boolean | null {
  return typeof actual === "string" && actual.length > 0
    ? actual === expected
    : null;
}

export function buildRestoreTargetAttestation(
  meta: RestoreAttestationMeta,
): RestoreTargetAttestation {
  const desiredDynamicConfigHash = computeGatewayConfigHash({
    telegramBotToken: meta.channels.telegram?.botToken,
    telegramWebhookSecret: meta.channels.telegram?.webhookSecret,
    slackCredentials: meta.channels.slack
      ? {
          botToken: meta.channels.slack.botToken,
          signingSecret: meta.channels.slack.signingSecret,
        }
      : undefined,
    whatsappConfig: toWhatsAppGatewayConfig(meta.channels.whatsapp),
  });

  const desiredAssetSha256 = buildRestoreAssetManifest().sha256;
  const snapshotDynamicConfigHash =
    meta.snapshotDynamicConfigHash ?? meta.snapshotConfigHash;

  const runtimeConfigFresh = compareHash(
    meta.runtimeDynamicConfigHash,
    desiredDynamicConfigHash,
  );
  const snapshotConfigFresh = compareHash(
    snapshotDynamicConfigHash,
    desiredDynamicConfigHash,
  );
  const runtimeAssetsFresh = compareHash(
    meta.runtimeAssetSha256,
    desiredAssetSha256,
  );
  const snapshotAssetsFresh = compareHash(
    meta.snapshotAssetSha256,
    desiredAssetSha256,
  );

  const reasons: string[] = [];

  if (runtimeConfigFresh === false) reasons.push("runtime-config-stale");
  if (runtimeAssetsFresh === false) reasons.push("runtime-assets-stale");

  if (snapshotConfigFresh === false) reasons.push("snapshot-config-stale");
  else if (snapshotConfigFresh === null)
    reasons.push("snapshot-config-unknown");

  if (snapshotAssetsFresh === false) reasons.push("snapshot-assets-stale");
  else if (snapshotAssetsFresh === null)
    reasons.push("snapshot-assets-unknown");

  if (meta.restorePreparedStatus !== "ready") {
    reasons.push(`restore-target-${meta.restorePreparedStatus}`);
  }

  const reusable =
    meta.restorePreparedStatus === "ready" &&
    snapshotConfigFresh === true &&
    snapshotAssetsFresh === true;

  return {
    desiredDynamicConfigHash,
    desiredAssetSha256,
    snapshotDynamicConfigHash: snapshotDynamicConfigHash ?? null,
    runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
    snapshotAssetSha256: meta.snapshotAssetSha256,
    runtimeAssetSha256: meta.runtimeAssetSha256,
    restorePreparedStatus: meta.restorePreparedStatus,
    restorePreparedReason: meta.restorePreparedReason ?? null,
    restorePreparedAt: meta.restorePreparedAt ?? null,
    runtimeConfigFresh,
    snapshotConfigFresh,
    runtimeAssetsFresh,
    snapshotAssetsFresh,
    reusable,
    needsPrepare: !reusable,
    reasons,
  };
}

export function buildRestoreTargetPlan(input: {
  attestation: RestoreTargetAttestation;
  status: SingleMeta["status"];
  sandboxId: string | null;
}): RestoreTargetPlan {
  const { attestation, status, sandboxId } = input;

  if (attestation.reusable) {
    return {
      schemaVersion: 1,
      status: "ready",
      blocking: false,
      reasons: [],
      actions: [],
    };
  }

  const reasons =
    attestation.reasons.length > 0
      ? attestation.reasons
      : ["restore-target-not-reusable"];

  const actions: RestoreTargetPlan["actions"] = [];

  if (status !== "running" || !sandboxId) {
    actions.push({
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
    });
  }

  actions.push({
    id: "prepare-destructive",
    priority: "required",
    title: "Prepare a fresh restore target",
    description: `The current snapshot cannot be reused: ${reasons.join(", ")}.`,
    request: {
      method: "POST",
      path: "/api/admin/prepare-restore",
      body: { destructive: true },
    },
  });

  return {
    schemaVersion: 1,
    status: "needs-prepare",
    blocking: true,
    reasons,
    actions,
  };
}
