import { ApiError, jsonError } from "@/shared/http";
import { requireMutationAuth, authJsonOk } from "@/server/auth/route-auth";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import { ensureSandboxRunning } from "@/server/sandbox/lifecycle";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let body: { snapshotId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError(
      new ApiError(400, "INVALID_JSON", "Request body must be valid JSON."),
    );
  }

  const { snapshotId } = body;
  if (typeof snapshotId !== "string" || !snapshotId.trim()) {
    return jsonError(
      new ApiError(400, "MISSING_SNAPSHOT_ID", "A snapshotId is required."),
    );
  }

  const meta = await getInitializedMeta();

  // Verify the snapshot exists in history or is the current snapshot
  const known =
    meta.snapshotId === snapshotId ||
    meta.snapshotHistory.some((s) => s.snapshotId === snapshotId);

  if (!known) {
    return jsonError(
      new ApiError(404, "SNAPSHOT_NOT_FOUND", "Snapshot not found in history."),
    );
  }

  // Set the target snapshot and clear sandbox so lifecycle picks it up
  await mutateMeta((next) => {
    next.snapshotId = snapshotId;
    next.sandboxId = null;
    next.portUrls = null;
    next.status = "stopped";
    next.lastError = null;
  });

  const origin = new URL(request.url).origin;
  const result = await ensureSandboxRunning({
    origin,
    reason: `restore-snapshot:${snapshotId}`,
  });

  return authJsonOk(
    {
      status: result.meta.status,
      snapshotId,
      state: result.state,
    },
    auth,
  );
}
