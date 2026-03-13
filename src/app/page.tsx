import { cookies, headers } from "next/headers";
import { AdminShell } from "@/components/admin-shell";
import { getAuthMode } from "@/server/env";
import {
  readSessionFromRequest,
  SESSION_COOKIE_NAME,
} from "@/server/auth/session";
import { getInitializedMeta, getStore } from "@/server/store/store";
import { getPublicChannelState } from "@/server/channels/state";
import { computeWouldBlock } from "@/server/firewall/state";
import type { StatusPayload } from "@/components/admin-types";

async function getInitialStatus(): Promise<StatusPayload | null> {
  try {
    const authMode = getAuthMode();

    let user: StatusPayload["user"];

    if (authMode === "deployment-protection") {
      user = {
        sub: "deployment-protection",
        name: "Protected by Vercel Authentication",
      };
    } else {
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
      if (!sessionCookie) return null;

      // Build a minimal Request so readSessionFromRequest can parse the cookie
      const fakeRequest = new Request("http://localhost", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      const session = await readSessionFromRequest(fakeRequest);
      if (!session) return null;
      user = session.user;
    }

    const meta = await getInitializedMeta();

    // Build a synthetic Request with the real Host header for webhook URL generation
    const hdrs = await headers();
    const host = hdrs.get("host") ?? "localhost";
    const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
    const syntheticRequest = new Request(`${proto}://${host}/`, {
      headers: {
        host,
        "x-forwarded-proto": proto,
      },
    });

    return {
      authMode,
      storeBackend: getStore().name,
      persistentStore: getStore().name !== "memory",
      status: meta.status,
      sandboxId: meta.sandboxId,
      snapshotId: meta.snapshotId,
      gatewayReady: false, // client poll will update this quickly
      gatewayUrl: "/gateway",
      lastError: meta.lastError,
      firewall: { ...meta.firewall, wouldBlock: computeWouldBlock(meta.firewall) },
      channels: await getPublicChannelState(syntheticRequest, meta),
      user,
    };
  } catch {
    // If anything fails, fall back to client-side fetch
    return null;
  }
}

export default async function HomePage() {
  const initialStatus = await getInitialStatus();
  return <AdminShell initialStatus={initialStatus} />;
}
