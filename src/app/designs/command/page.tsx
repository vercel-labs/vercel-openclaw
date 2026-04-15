import { cookies, headers } from "next/headers";
import { CommandShell } from "@/components/designs/command-shell";
import { getAuthMode } from "@/server/env";
import {
  hasAdminSession,
  ADMIN_SESSION_COOKIE_NAME,
} from "@/server/auth/admin-auth";
import { getInitializedMeta, getStore } from "@/server/store/store";
import { getPublicChannelState } from "@/server/channels/state";
import { computeWouldBlock } from "@/server/firewall/state";
import { buildRestoreTargetAttestation, buildRestoreTargetPlan } from "@/server/sandbox/restore-attestation";
import { getSandboxSleepConfig } from "@/server/sandbox/timeout";
import type { StatusPayload } from "@/components/admin-types";
import { GATEWAY_CHAT_PATH } from "@/shared/gateway-paths";

async function getInitialStatus(): Promise<StatusPayload | null> {
  try {
    const cookieStore = await cookies();
    const adminCookie = cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value;
    if (!adminCookie) return null;

    const fakeRequest = new Request("http://localhost", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${adminCookie}` },
    });
    const isAdmin = await hasAdminSession(fakeRequest);
    if (!isAdmin) return null;

    const authMode = getAuthMode();
    const meta = await getInitializedMeta();

    const hdrs = await headers();
    const host = hdrs.get("host") ?? "localhost";
    const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
    const syntheticRequest = new Request(`${proto}://${host}/`, {
      headers: { host, "x-forwarded-proto": proto },
    });

    const sleepConfig = getSandboxSleepConfig();
    const restoreAttestation = buildRestoreTargetAttestation(meta);
    const restorePlan = buildRestoreTargetPlan({
      attestation: restoreAttestation,
      status: meta.status,
      sandboxId: meta.sandboxId,
    });

    return {
      authMode,
      storeBackend: getStore().name,
      persistentStore: getStore().name !== "memory",
      status: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
      gatewayReady: false,
      gatewayStatus: "unknown",
      gatewayCheckedAt: null,
      gatewayUrl: GATEWAY_CHAT_PATH,
      lastError: meta.lastError,
      lastKeepaliveAt: meta.lastAccessedAt,
      sleepAfterMs: sleepConfig.sleepAfterMs,
      heartbeatIntervalMs: sleepConfig.heartbeatIntervalMs,
      timeoutRemainingMs: null,
      timeoutSource: "none",
      setupProgress: null,
      firewall: { ...meta.firewall, wouldBlock: computeWouldBlock(meta.firewall) },
      channels: await getPublicChannelState(syntheticRequest, meta),
      restoreTarget: {
        restorePreparedStatus: meta.restorePreparedStatus,
        restorePreparedReason: meta.restorePreparedReason,
        restorePreparedAt: meta.restorePreparedAt,
        snapshotDynamicConfigHash: meta.snapshotDynamicConfigHash,
        runtimeDynamicConfigHash: meta.runtimeDynamicConfigHash,
        snapshotAssetSha256: meta.snapshotAssetSha256,
        runtimeAssetSha256: meta.runtimeAssetSha256,
        attestation: restoreAttestation,
        plan: restorePlan,
        oracle: meta.restoreOracle,
      },
      lifecycle: {
        lastRestoreMetrics: meta.lastRestoreMetrics ?? null,
        restoreHistory: (meta.restoreHistory ?? []).slice(0, 5),
        lastTokenRefreshAt: meta.lastTokenRefreshAt,
        lastTokenSource: meta.lastTokenSource ?? null,
        lastTokenExpiresAt: meta.lastTokenExpiresAt ?? null,
        lastTokenRefreshError: meta.lastTokenRefreshError ?? null,
        consecutiveTokenRefreshFailures:
          meta.consecutiveTokenRefreshFailures ?? 0,
        breakerOpenUntil: meta.breakerOpenUntil ?? null,
      },
      user: { sub: "admin", name: "Admin" },
    };
  } catch {
    return null;
  }
}

export default async function CommandDesignPage() {
  const initialStatus = await getInitialStatus();
  return <CommandShell initialStatus={initialStatus} />;
}
