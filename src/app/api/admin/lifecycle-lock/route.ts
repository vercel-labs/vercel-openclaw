import { jsonError } from "@/shared/http";
import { requireAdminAuth } from "@/server/auth/admin-auth";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { logWarn } from "@/server/log";
import { getStore } from "@/server/store/store";
import {
  initLockKey,
  lifecycleLockKey,
  startLockKey,
  tokenRefreshLockKey,
} from "@/server/store/keyspace";

type LockDescriptor = {
  id: "lifecycle" | "start" | "init" | "token-refresh";
  key: string;
};

function locks(): LockDescriptor[] {
  return [
    { id: "lifecycle", key: lifecycleLockKey() },
    { id: "start", key: startLockKey() },
    { id: "init", key: initLockKey() },
    { id: "token-refresh", key: tokenRefreshLockKey() },
  ];
}

function redactToken(token: string | null): string | null {
  if (!token) return null;
  return `${token.slice(0, 8)}…`;
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAdminAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const store = getStore();
    const entries = await Promise.all(
      locks().map(async (lock) => {
        const token = await store.getValue<string>(lock.key);
        return {
          id: lock.id,
          key: lock.key,
          held: token !== null,
          tokenPreview: redactToken(token),
        };
      }),
    );
    return Response.json({ locks: entries });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(request.url);
    const idParam = url.searchParams.get("id");
    const all = url.searchParams.get("all") === "1";

    const targets = all
      ? locks()
      : locks().filter((lock) => (idParam ? lock.id === idParam : lock.id === "lifecycle"));

    if (targets.length === 0) {
      return Response.json(
        { error: "NO_MATCHING_LOCK", message: `Unknown lock id: ${idParam}` },
        { status: 400 },
      );
    }

    const store = getStore();
    const results = await Promise.all(
      targets.map(async (lock) => {
        const tokenBefore = await store.getValue<string>(lock.key);
        if (tokenBefore === null) {
          return { id: lock.id, key: lock.key, released: false, reason: "not-held" as const };
        }
        await store.deleteValue(lock.key);
        logWarn("sandbox.lifecycle_lock_force_released", {
          id: lock.id,
          key: lock.key,
          tokenPreview: redactToken(tokenBefore),
        });
        return {
          id: lock.id,
          key: lock.key,
          released: true,
          tokenPreview: redactToken(tokenBefore),
        };
      }),
    );

    const response = Response.json({ released: results });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
