import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin-shell";
import { getAuthMode } from "@/server/env";
import {
  hasAdminSession,
  ADMIN_SESSION_COOKIE_NAME,
} from "@/server/auth/admin-auth";
import { getInitializedMeta, getStore } from "@/server/store/store";
import { getPublicChannelState } from "@/server/channels/state";
import { computeWouldBlock } from "@/server/firewall/state";
import { getSandboxSleepConfig } from "@/server/sandbox/timeout";
import type { StatusPayload } from "@/components/admin-types";

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
      headers: {
        host,
        "x-forwarded-proto": proto,
      },
    });

    const sleepConfig = getSandboxSleepConfig();

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
      gatewayUrl: "/gateway",
      lastError: meta.lastError,
      lastKeepaliveAt: meta.lastAccessedAt,
      sleepAfterMs: sleepConfig.sleepAfterMs,
      heartbeatIntervalMs: sleepConfig.heartbeatIntervalMs,
      timeoutRemainingMs: null,
      timeoutSource: "none",
      firewall: { ...meta.firewall, wouldBlock: computeWouldBlock(meta.firewall) },
      channels: await getPublicChannelState(syntheticRequest, meta),
      user: { sub: "admin", name: "Admin" },
    };
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const initialStatus = await getInitialStatus();
  return <AdminShell initialStatus={initialStatus} />;
}
