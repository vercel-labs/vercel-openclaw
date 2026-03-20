import { jsonOk } from "@/shared/http";
import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { extractRequestId, logError, logInfo } from "@/server/log";

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);

  const blocked = requireDebugEnabled(request, {
    routeSource: "debug.sdk_import_timing",
  });
  if (blocked) {
    return blocked;
  }

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  try {
    const t1 = Date.now();
    const { Sandbox } = await import("@vercel/sandbox");
    const importMs = Date.now() - t1;

    const t2 = Date.now();
    const { Sandbox: Sandbox2 } = await import("@vercel/sandbox");
    const import2Ms = Date.now() - t2;

    const proof =
      typeof Sandbox === "function" && typeof Sandbox2 === "function";

    logInfo("debug.sdk_import_timing_completed", {
      requestId,
      importMs,
      import2Ms,
      proof,
    });

    return jsonOk({ importMs, import2Ms, proof });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logError("debug.sdk_import_timing_failed", {
      requestId,
      error: message,
    });

    return Response.json(
      {
        error: "SDK_IMPORT_TIMING_FAILED",
        message: "Internal server error.",
      },
      { status: 500 },
    );
  }
}
