import { getAuthMode } from "@/server/env";
import { getStore, getInitializedMeta } from "@/server/store/store";

export async function GET(): Promise<Response> {
  const meta = await getInitializedMeta();
  return Response.json({
    ok: true,
    authMode: getAuthMode(),
    storeBackend: getStore().name,
    status: meta.status,
    hasSnapshot: Boolean(meta.snapshotId),
  });
}
