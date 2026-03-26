import {
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { jsonError } from "@/shared/http";
import { getPublicOrigin } from "@/server/public-url";
import { extractRequestId, logError, logInfo } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";
import { prepareRestoreTarget } from "@/server/sandbox/lifecycle";
import {
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import type { RestoreTargetInspectionPayload } from "@/shared/launch-verification";

async function buildInspectionPayload(
  request: Request,
  destructive: boolean,
): Promise<RestoreTargetInspectionPayload> {
  const origin = getPublicOrigin(request);

  const preview = await prepareRestoreTarget({
    origin,
    reason: destructive
      ? "admin.restore-target.prepare"
      : "admin.restore-target.inspect",
    destructive,
  });

  const meta = await getInitializedMeta();
  const attestation = buildRestoreTargetAttestation(meta);
  const plan = buildRestoreTargetPlan({
    attestation,
    status: meta.status,
    sandboxId: meta.sandboxId,
  });

  return {
    ok: destructive ? preview.ok : true,
    generatedAt: new Date().toISOString(),
    attestation,
    preview: {
      ok: preview.ok,
      destructive: preview.destructive,
      state: preview.state,
      reason: preview.reason ?? null,
      snapshotId: preview.snapshotId,
      snapshotDynamicConfigHash: preview.snapshotDynamicConfigHash,
      runtimeDynamicConfigHash: preview.runtimeDynamicConfigHash,
      snapshotAssetSha256: preview.snapshotAssetSha256,
      runtimeAssetSha256: preview.runtimeAssetSha256,
      preparedAt: preview.preparedAt,
      actions: preview.actions,
    },
    plan,
  };
}

function logInspection(
  event: "restore_target.inspect" | "restore_target.prepare_completed",
  requestId: string | null,
  payload: RestoreTargetInspectionPayload,
  destructive: boolean,
): void {
  logInfo(event, {
    requestId,
    destructive,
    ok: payload.ok,
    reusable: payload.attestation.reusable,
    needsPrepare: payload.attestation.needsPrepare,
    reasons: payload.attestation.reasons,
    restorePreparedStatus: payload.attestation.restorePreparedStatus,
    restorePreparedReason: payload.attestation.restorePreparedReason,
    planStatus: payload.plan.status,
    planActionIds: payload.plan.actions.map((action) => action.id),
    previewOk: payload.preview.ok,
    previewState: payload.preview.state,
    previewReason: payload.preview.reason,
  });
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const payload = await buildInspectionPayload(request, false);
    logInspection("restore_target.inspect", requestId ?? null, payload, false);
    return authJsonOk(payload, auth);
  } catch (error) {
    logError("restore_target.inspect_failed", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  let destructive = false;
  try {
    const body = (await request.json()) as { destructive?: boolean };
    destructive = body.destructive === true;
  } catch {
    destructive = false;
  }

  try {
    const payload = await buildInspectionPayload(request, destructive);
    logInspection(
      "restore_target.prepare_completed",
      requestId ?? null,
      payload,
      destructive,
    );
    return authJsonOk(payload, auth);
  } catch (error) {
    logError("restore_target.prepare_failed", {
      requestId,
      destructive,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError(error);
  }
}
