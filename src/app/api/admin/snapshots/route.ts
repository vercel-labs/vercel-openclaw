import { randomUUID } from "node:crypto";

import { Sandbox } from "@vercel/sandbox";

import type { SnapshotRecord } from "@/shared/types";
import { ApiError, jsonError } from "@/shared/http";
import {
  requireJsonRouteAuth,
  requireMutationAuth,
  authJsonOk,
} from "@/server/auth/route-auth";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";

const MAX_SNAPSHOT_HISTORY = 50;

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();
  return authJsonOk({ snapshots: meta.snapshotHistory }, auth);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const meta = await getInitializedMeta();
  if (!meta.sandboxId || meta.status !== "running") {
    return jsonError(
      new ApiError(409, "SANDBOX_NOT_RUNNING", "Sandbox is not running."),
    );
  }

  let body: { reason?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — reason is optional
  }

  const reason = typeof body.reason === "string" ? body.reason : "manual";

  try {
    const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
    const snapshot = await sandbox.snapshot();

    const record: SnapshotRecord = {
      id: randomUUID(),
      snapshotId: snapshot.snapshotId,
      timestamp: Date.now(),
      reason,
    };

    const updated = await mutateMeta((next) => {
      next.snapshotId = snapshot.snapshotId;
      next.sandboxId = null;
      next.portUrls = null;
      next.status = "stopped";
      next.lastAccessedAt = Date.now();
      next.lastError = null;
      next.snapshotHistory = [record, ...next.snapshotHistory].slice(
        0,
        MAX_SNAPSHOT_HISTORY,
      );
    });

    return authJsonOk(
      {
        status: updated.status,
        snapshotId: snapshot.snapshotId,
        record,
      },
      auth,
    );
  } catch (error) {
    return jsonError(error);
  }
}
