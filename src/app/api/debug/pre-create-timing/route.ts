import { jsonOk } from "@/shared/http";
import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { resolveAiGatewayCredentialOptional } from "@/server/env";
import { toNetworkPolicy } from "@/server/firewall/policy";
import { extractRequestId, logError, logInfo } from "@/server/log";
import { buildGatewayConfig } from "@/server/openclaw/config";
import { buildRestoreAssetManifest } from "@/server/openclaw/restore-assets";
import { getPublicOrigin } from "@/server/public-url";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";

type StepTiming = {
  step: string;
  ms: number;
};

export async function POST(request: Request): Promise<Response> {
  const requestId = extractRequestId(request);

  const blocked = requireDebugEnabled(request, {
    routeSource: "debug.pre_create_timing",
  });
  if (blocked) {
    return blocked;
  }

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const timings: StepTiming[] = [];

  const mark = async <T>(
    step: string,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    const result = await fn();
    timings.push({ step, ms: Date.now() - startedAt });
    return result;
  };

  try {
    await mark("getInitializedMeta_1", () => getInitializedMeta());

    const credential = await mark("resolveAiGatewayCredential", () =>
      resolveAiGatewayCredentialOptional(),
    );

    await mark("mutateMeta_restoring", () =>
      mutateMeta(() => {
        // no-op for timing only
      }),
    );

    const latest = await mark("getInitializedMeta_2", () =>
      getInitializedMeta(),
    );

    await mark("buildGatewayConfig", () =>
      buildGatewayConfig(credential?.token, getPublicOrigin(request)),
    );

    await mark("toNetworkPolicy", () =>
      toNetworkPolicy(latest.firewall.mode, latest.firewall.allowlist),
    );

    await mark("buildRestoreAssetManifest", () =>
      buildRestoreAssetManifest(),
    );

    const totalMs = timings.reduce((sum, entry) => sum + entry.ms, 0);

    logInfo("debug.pre_create_timing_completed", {
      requestId,
      stepCount: timings.length,
      totalMs,
      steps: timings.map((entry) => entry.step),
    });

    return jsonOk({
      timings,
      totalMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logError("debug.pre_create_timing_failed", {
      requestId,
      error: message,
      stepCount: timings.length,
      steps: timings.map((entry) => entry.step),
    });

    return Response.json(
      {
        error: "PRE_CREATE_TIMING_FAILED",
        message: "Internal server error.",
        timings,
      },
      { status: 500 },
    );
  }
}
