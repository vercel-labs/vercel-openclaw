import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getPublicChannelState } from "@/server/channels/state";
import { getAuthMode } from "@/server/env";
import { computeWouldBlock } from "@/server/firewall/state";
import { extractRequestId, logError } from "@/server/log";
import {
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import {
  getRunningSandboxTimeoutRemainingMs,
  probeGatewayReady,
  reconcileSnapshottingStatus,
  reconcileStaleRunningStatus,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";
import { readSetupProgress } from "@/server/sandbox/setup-progress";
import {
  estimateSandboxTimeoutRemainingMs,
  getSandboxSleepConfig,
} from "@/server/sandbox/timeout";
import { getStore, getInitializedMeta, mutateMeta } from "@/server/store/store";
import { jsonError } from "@/shared/http";
import type { SingleMeta } from "@/shared/types";
import { GATEWAY_CHAT_PATH } from "@/shared/gateway-paths";

type GatewayStatus = "ready" | "not-ready" | "unknown";

function toGatewayReady(status: GatewayStatus): boolean {
  return status === "ready";
}

function getCachedGatewayStatus(meta: SingleMeta): {
  gatewayStatus: GatewayStatus;
  gatewayCheckedAt: number | null;
} {
  if (
    meta.sandboxId &&
    meta.lastGatewayProbeSandboxId === meta.sandboxId &&
    typeof meta.lastGatewayProbeReady === "boolean"
  ) {
    return {
      gatewayStatus: meta.lastGatewayProbeReady ? "ready" : "not-ready",
      gatewayCheckedAt: meta.lastGatewayProbeAt ?? null,
    };
  }

  return {
    gatewayStatus: "unknown",
    gatewayCheckedAt: null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const requestId = extractRequestId(request);

  try {
    const url = new URL(request.url);
    const includeHealth = url.searchParams.get("health") === "1";
    const sleepConfig = getSandboxSleepConfig();
    const meta = await getInitializedMeta();

    let responseMeta = meta;
    let gatewayStatus: GatewayStatus;
    let gatewayCheckedAt: number | null;
    let timeoutRemainingMs: number | null;
    let timeoutSource: "live" | "estimated" | "none";

    if (includeHealth) {
      const checkedAt = Date.now();
      const probe = await probeGatewayReady();
      responseMeta = await mutateMeta((next) => {
        next.lastGatewayProbeAt = checkedAt;
        next.lastGatewayProbeReady = probe.ready;
        next.lastGatewayProbeSandboxId = next.sandboxId;
      });
      gatewayStatus = probe.ready ? "ready" : "not-ready";
      gatewayCheckedAt = checkedAt;
      timeoutRemainingMs = await getRunningSandboxTimeoutRemainingMs();
      timeoutSource = "live";
    } else {
      const cachedGateway = getCachedGatewayStatus(meta);
      gatewayStatus = cachedGateway.gatewayStatus;
      gatewayCheckedAt = cachedGateway.gatewayCheckedAt;
      timeoutRemainingMs = estimateSandboxTimeoutRemainingMs(
        meta.lastAccessedAt,
        sleepConfig.sleepAfterMs,
      );
      timeoutSource = "estimated";

      // When metadata says "running" but estimated timeout has elapsed,
      // ask the Sandbox SDK for the real status and reconcile metadata.
      if (
        responseMeta.status === "running" &&
        timeoutRemainingMs != null &&
        timeoutRemainingMs <= 0
      ) {
        responseMeta = await reconcileStaleRunningStatus();
      }

      // When the cached gateway probe is older than 2x the heartbeat
      // interval, the heartbeat may have stopped running.  Reconcile so
      // the UI doesn't show a stale "running" status indefinitely.
      if (
        responseMeta.status === "running" &&
        gatewayCheckedAt != null &&
        Date.now() - gatewayCheckedAt > sleepConfig.heartbeatIntervalMs * 2
      ) {
        responseMeta = await reconcileStaleRunningStatus();
      }

      // When metadata says "snapshotting", the app is waiting for a
      // non-blocking stop to finish its auto-snapshot.  Poll the SDK so
      // the UI flips to "stopped" (or "error") as soon as the phase ends.
      if (responseMeta.status === "snapshotting") {
        responseMeta = await reconcileSnapshottingStatus();
      }
    }

    const restoreAttestation = buildRestoreTargetAttestation(responseMeta);
    const restorePlan = buildRestoreTargetPlan({
      attestation: restoreAttestation,
      status: responseMeta.status,
      sandboxId: responseMeta.sandboxId,
    });
    const includeSetupProgress =
      responseMeta.status === "creating" ||
      responseMeta.status === "setup" ||
      responseMeta.status === "booting" ||
      responseMeta.status === "error";
    const setupProgress = includeSetupProgress
      ? await readSetupProgress(responseMeta.id, responseMeta.lifecycleAttemptId)
      : null;

    const sandboxSdkVersion = await import("@vercel/sandbox/package.json", { with: { type: "json" } })
      .then((m) => (m.default as { version?: string }).version ?? null)
      .catch(() => null);

    const response = Response.json({
      authMode: getAuthMode(),
      storeBackend: getStore().name,
      persistentStore: getStore().name !== "memory",
      sandboxSdkVersion,
      openclawVersion: responseMeta.openclawVersion,
      status: responseMeta.status,
      sandboxId: responseMeta.sandboxId,
      snapshotId: responseMeta.snapshotId,
      gatewayReady: toGatewayReady(gatewayStatus),
      gatewayStatus,
      gatewayCheckedAt,
      gatewayUrl: GATEWAY_CHAT_PATH,
      lastError: responseMeta.lastError,
      lastKeepaliveAt: responseMeta.lastAccessedAt,
      sleepAfterMs: sleepConfig.sleepAfterMs,
      heartbeatIntervalMs: sleepConfig.heartbeatIntervalMs,
      timeoutRemainingMs,
      timeoutSource,
      firewall: {
        ...responseMeta.firewall,
        wouldBlock: computeWouldBlock(responseMeta.firewall),
      },
      channels: await getPublicChannelState(request, responseMeta),
      restoreTarget: {
        restorePreparedStatus: responseMeta.restorePreparedStatus,
        restorePreparedReason: responseMeta.restorePreparedReason,
        restorePreparedAt: responseMeta.restorePreparedAt,
        snapshotDynamicConfigHash: responseMeta.snapshotDynamicConfigHash,
        runtimeDynamicConfigHash: responseMeta.runtimeDynamicConfigHash,
        snapshotAssetSha256: responseMeta.snapshotAssetSha256,
        runtimeAssetSha256: responseMeta.runtimeAssetSha256,
        attestation: restoreAttestation,
        plan: restorePlan,
        oracle: responseMeta.restoreOracle,
      },
      lifecycle: {
        lastRestoreMetrics: responseMeta.lastRestoreMetrics ?? null,
        restoreHistory: (responseMeta.restoreHistory ?? []).slice(0, 5),
        lastTokenRefreshAt: responseMeta.lastTokenRefreshAt,
        lastTokenSource: responseMeta.lastTokenSource ?? null,
        lastTokenExpiresAt: responseMeta.lastTokenExpiresAt ?? null,
        lastTokenRefreshError: responseMeta.lastTokenRefreshError ?? null,
        consecutiveTokenRefreshFailures:
          responseMeta.consecutiveTokenRefreshFailures ?? 0,
        breakerOpenUntil: responseMeta.breakerOpenUntil ?? null,
      },
      setupProgress,
      user: { sub: "admin", name: "Admin" },
    });

    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (requestId) ctx.requestId = requestId;
    logError("status.get_failed", ctx);
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const heartbeatRequestId = extractRequestId(request);

  try {
    const meta = await touchRunningSandbox();
    const response = Response.json({
      ok: true,
      status: meta.status,
    });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    const ctx: Record<string, unknown> = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (heartbeatRequestId) ctx.requestId = heartbeatRequestId;
    logError("status.heartbeat_failed", ctx);
    return jsonError(error);
  }
}
