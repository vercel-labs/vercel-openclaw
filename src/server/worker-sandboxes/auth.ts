import { createHash, timingSafeEqual } from "node:crypto";

import { getInitializedMeta } from "@/server/store/store";

export async function buildWorkerSandboxBearerToken(): Promise<string> {
  const meta = await getInitializedMeta();
  return createHash("sha256")
    .update("worker-sandbox:v1\0")
    .update(meta.gatewayToken)
    .digest("hex");
}

export async function authorizeWorkerSandboxRequest(
  request: Request,
): Promise<boolean> {
  const supplied = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!supplied) {
    return false;
  }
  const expected = await buildWorkerSandboxBearerToken();
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
