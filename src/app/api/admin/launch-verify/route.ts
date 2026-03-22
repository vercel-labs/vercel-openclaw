import {
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import {
  buildDeployPreflight,
  getLaunchVerifyBlocking,
  LAUNCH_VERIFY_SKIP_PHASE_IDS,
  type LaunchVerifyBlockingResult,
  type PreflightPayload,
} from "@/server/deploy-preflight";
import { logInfo, logError } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  ensureRunningSandboxDynamicConfigFresh,
  getSandboxDomain,
  stopSandbox,
  waitForSandboxReady,
  type DynamicConfigReconcileResult,
  type SandboxReadyAction,
} from "@/server/sandbox/lifecycle";
import { getOpenclawPackageSpec } from "@/server/env";
import { detectDrift } from "@/server/openclaw/bootstrap";
import { computeGatewayConfigHash } from "@/server/openclaw/config";
import { getInitializedMeta } from "@/server/store/store";
import {
  publishLaunchVerifyQueueProbe,
  runLaunchVerifyCompletion,
  waitForLaunchVerifyQueueResult,
} from "@/server/launch-verify/queue-probe";
import {
  readChannelReadiness,
  writeChannelReadiness,
} from "@/server/launch-verify/state";
import type {
  ChannelReadiness,
  LaunchVerificationDiagnostics,
  LaunchVerificationPayload,
  LaunchVerificationPhase,
  LaunchVerificationPhaseId,
  LaunchVerificationRuntime,
  LaunchVerificationSandboxHealth,
  LaunchVerificationStreamEvent,
  LaunchVerifyCompletionLog,
} from "@/shared/launch-verification";

const ENSURE_POLL_MS = 2_000;
const ENSURE_TIMEOUT_MS = 120_000;

async function runPhase(
  id: LaunchVerificationPhaseId,
  fn: () => Promise<string>,
): Promise<LaunchVerificationPhase> {
  const start = Date.now();
  try {
    const message = await fn();
    const phase: LaunchVerificationPhase = {
      id,
      status: "pass",
      durationMs: Date.now() - start,
      message,
    };
    logInfo(`launch_verify.phase_pass`, { phase: id, durationMs: phase.durationMs });
    return phase;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const phase: LaunchVerificationPhase = {
      id,
      status: "fail",
      durationMs: Date.now() - start,
      message: `Phase ${id} failed.`,
      error: errMsg,
    };
    logError(`launch_verify.phase_fail`, { phase: id, error: errMsg });
    return phase;
  }
}

function skipPhase(id: LaunchVerificationPhaseId, message: string): LaunchVerificationPhase {
  logInfo("launch_verify.phase_skip", { phase: id, message });
  return { id, status: "skip", durationMs: 0, message };
}

function buildLaunchVerificationDiagnostics(
  preflight: PreflightPayload | null,
  blocking: LaunchVerifyBlockingResult,
): LaunchVerificationDiagnostics {
  const failingChannelIds = preflight
    ? (Object.values(preflight.channels ?? {})
        .filter((channel) => channel.status === "fail")
        .map((channel) => channel.channel) as Array<"slack" | "telegram" | "discord">)
    : [];

  return {
    blocking: blocking.blocking,
    failingCheckIds: [...blocking.failingCheckIds],
    requiredActionIds: [...blocking.requiredActionIds],
    recommendedActionIds: [...blocking.recommendedActionIds],
    warningChannelIds: failingChannelIds,
    failingChannelIds,
    skipPhaseIds: [...blocking.skipPhaseIds],
  };
}

function buildLaunchVerifyCompletionLog(input: {
  payload: LaunchVerificationPayload;
  readiness: ChannelReadiness;
}): LaunchVerifyCompletionLog {
  return {
    ok: input.payload.ok,
    mode: input.payload.mode,
    phaseCount: input.payload.phases.length,
    totalMs:
      new Date(input.payload.completedAt).getTime() -
      new Date(input.payload.startedAt).getTime(),
    channelReady: input.readiness.ready,
    failingCheckIds: input.payload.diagnostics?.failingCheckIds ?? [],
    requiredActionIds: input.payload.diagnostics?.requiredActionIds ?? [],
    recommendedActionIds: input.payload.diagnostics?.recommendedActionIds ?? [],
    failingChannelIds:
      input.payload.diagnostics?.failingChannelIds ??
      input.payload.diagnostics?.warningChannelIds ??
      [],
    dynamicConfigVerified: input.payload.runtime?.dynamicConfigVerified ?? null,
    dynamicConfigReason: input.payload.runtime?.dynamicConfigReason,
    repaired: input.payload.sandboxHealth?.repaired ?? null,
    configReconciled: input.payload.sandboxHealth?.configReconciled ?? null,
    configReconcileReason: input.payload.sandboxHealth?.configReconcileReason,
  };
}

function buildSandboxHealth(input: {
  ensureReadyAction: SandboxReadyAction | null;
  configReconcile: DynamicConfigReconcileResult | null;
  configReconcileError: boolean;
}): LaunchVerificationSandboxHealth {
  return {
    repaired: input.ensureReadyAction !== null &&
      input.ensureReadyAction !== "already-running",
    configReconciled: input.configReconcileError
      ? false
      : (input.configReconcile?.verified ?? null),
    configReconcileReason: input.configReconcileError
      ? "error"
      : (input.configReconcile?.reason ?? "skipped"),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers — used by both JSON and NDJSON code paths
// ---------------------------------------------------------------------------

type LaunchVerificationRuntimeMeta = Awaited<ReturnType<typeof getInitializedMeta>>;

function buildPreflightPassMessage(preflight: PreflightPayload): string {
  const warningCheckIds = preflight.checks
    .filter((check) => check.status === "warn")
    .map((check) => check.id);

  if (warningCheckIds.length === 0) {
    return `All ${preflight.checks.length} config checks passed.`;
  }

  return `Preflight passed with ${warningCheckIds.length} warning${
    warningCheckIds.length === 1 ? "" : "s"
  }: ${warningCheckIds.join(", ")}.`;
}

function buildLaunchVerificationRuntime(
  runtimeMeta: LaunchVerificationRuntimeMeta,
): LaunchVerificationRuntime | undefined {
  const packageSpec = getOpenclawPackageSpec();
  if (!packageSpec) return undefined;

  const expectedConfigHash = computeGatewayConfigHash({
    telegramBotToken: runtimeMeta.channels.telegram?.botToken,
    telegramWebhookSecret: runtimeMeta.channels.telegram?.webhookSecret,
    slackCredentials: runtimeMeta.channels.slack
      ? {
          botToken: runtimeMeta.channels.slack.botToken,
          signingSecret: runtimeMeta.channels.slack.signingSecret,
        }
      : undefined,
  });

  return {
    packageSpec,
    installedVersion: runtimeMeta.openclawVersion,
    drift: detectDrift(packageSpec, runtimeMeta.openclawVersion),
    expectedConfigHash,
    lastRestoreConfigHash: runtimeMeta.lastRestoreMetrics?.dynamicConfigHash ?? null,
    dynamicConfigVerified:
      runtimeMeta.lastRestoreMetrics?.dynamicConfigHash == null
        ? null
        : runtimeMeta.lastRestoreMetrics.dynamicConfigHash === expectedConfigHash,
    dynamicConfigReason: runtimeMeta.lastRestoreMetrics?.dynamicConfigReason,
  };
}

/**
 * Evaluate the preflight phase: build the preflight payload, check for
 * blocking failures via the canonical helper, and return both the phase
 * result and the blocking decision.
 *
 * This is extracted from `runPhase` so both JSON and NDJSON paths can
 * access the blocking result without re-computing preflight.
 */
async function evaluatePreflight(request: Request): Promise<{
  phase: LaunchVerificationPhase;
  blocking: LaunchVerifyBlockingResult;
  diagnostics: LaunchVerificationDiagnostics;
}> {
  const start = Date.now();
  let preflight: PreflightPayload;
  try {
    preflight = await buildDeployPreflight(request);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    const blocking: LaunchVerifyBlockingResult = {
      blocking: true,
      failingCheckIds: [],
      requiredActionIds: [],
      recommendedActionIds: [],
      errorMessage: errMsg,
      skipPhaseIds: LAUNCH_VERIFY_SKIP_PHASE_IDS,
    };

    const diagnostics = buildLaunchVerificationDiagnostics(null, blocking);

    logError("launch_verify.phase_fail", {
      phase: "preflight",
      error: errMsg,
      diagnostics,
    });

    return {
      phase: {
        id: "preflight",
        status: "fail",
        durationMs: Date.now() - start,
        message: "Phase preflight failed.",
        error: errMsg,
      },
      blocking,
      diagnostics,
    };
  }

  const blocking = getLaunchVerifyBlocking(preflight);
  const diagnostics = buildLaunchVerificationDiagnostics(preflight, blocking);

  logInfo("launch_verify.preflight_evaluated", diagnostics);

  if (blocking.blocking) {
    logError("launch_verify.phase_fail", {
      phase: "preflight",
      error: blocking.errorMessage,
      diagnostics,
    });

    return {
      phase: {
        id: "preflight",
        status: "fail",
        durationMs: Date.now() - start,
        message: "Phase preflight failed.",
        error: blocking.errorMessage ?? "Unknown preflight error.",
      },
      blocking,
      diagnostics,
    };
  }

  const phase: LaunchVerificationPhase = {
    id: "preflight",
    status: "pass",
    durationMs: Date.now() - start,
    message: buildPreflightPassMessage(preflight),
  };

  logInfo("launch_verify.phase_pass", {
    phase: "preflight",
    durationMs: phase.durationMs,
    diagnostics,
  });

  return { phase, blocking, diagnostics };
}

// NDJSON stream event types — re-export shared types for internal use
type StreamEvent = LaunchVerificationStreamEvent;

function wantsStream(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/x-ndjson");
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const startedAt = new Date().toISOString();

  const url = new URL(request.url);
  const queryMode = url.searchParams.get("mode");
  let bodyMode: string | undefined;
  try {
    const body = (await request.json()) as { mode?: string };
    bodyMode = body.mode;
  } catch {
    // No JSON body — use query param or default to safe.
  }
  const rawMode = queryMode ?? bodyMode;
  const mode = rawMode === "destructive" ? "destructive" : "safe";

  logInfo("launch_verify.mode_resolved", {
    source: queryMode ? "query" : bodyMode ? "body" : "default",
    mode,
  });

  logInfo("launch_verify.started", { mode });

  const streaming = wantsStream(request);

  if (streaming) {
    return buildStreamingResponse(request, auth, mode, startedAt);
  }

  return buildJsonResponse(request, auth, mode, startedAt);
}

function buildStreamingResponse(
  request: Request,
  auth: { setCookieHeader: string | null },
  mode: "safe" | "destructive",
  startedAt: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let seq = 0;

      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }

      function emitPhase(phase: LaunchVerificationPhase, final: boolean): void {
        emit({ type: "phase", phase, seq: seq++, final });
      }

      function emitRunning(id: LaunchVerificationPhaseId): void {
        emitPhase(
          { id, status: "running", durationMs: 0, message: "Running\u2026" },
          false,
        );
      }

      const phases: LaunchVerificationPhase[] = [];

      emitRunning("preflight");
      const { phase: preflightPhase, blocking, diagnostics } = await evaluatePreflight(request);
      phases.push(preflightPhase);
      emitPhase(preflightPhase, true);
      emit({ type: "summary", payload: diagnostics });

      if (blocking.blocking) {
        for (const id of blocking.skipPhaseIds) {
          const s = skipPhase(id as LaunchVerificationPhaseId, "Skipped: preflight failed.");
          phases.push(s);
          emitPhase(s, true);
        }

        const payload: LaunchVerificationPayload = {
          ok: false, mode, startedAt,
          completedAt: new Date().toISOString(), phases,
          diagnostics,
        };
        const readiness = await writeChannelReadiness(payload);

        logInfo(
          "launch_verify.completed",
          buildLaunchVerifyCompletionLog({ payload, readiness }),
        );

        emit({ type: "result", payload: { ...payload, channelReadiness: readiness } });
        controller.close();
        return;
      }

      const origin = getPublicOrigin(request);

      emitRunning("queuePing");
      const queuePingPhase = await runPhase("queuePing", async () => {
        const { probeId, messageId } = await publishLaunchVerifyQueueProbe({
          kind: "ack", origin,
        });
        const result = await waitForLaunchVerifyQueueResult(probeId, 60_000);
        if (!result.ok) {
          throw new Error(result.error ?? "Queue delivery probe failed.");
        }
        return `Vercel Queue delivered callback ${messageId ?? "unknown"}.`;
      });
      phases.push(queuePingPhase);
      emitPhase(queuePingPhase, true);

      let ensureReadyAction: SandboxReadyAction | null = null;

      emitRunning("ensureRunning");
      const ensurePhase = await runPhase("ensureRunning", async () => {
        const result = await waitForSandboxReady({
          origin, reason: "launch-verify",
          timeoutMs: ENSURE_TIMEOUT_MS, pollIntervalMs: ENSURE_POLL_MS,
          reconcile: true,
        });
        ensureReadyAction = result.readyAction;
        switch (result.readyAction) {
          case "already-running":
            return "Sandbox already running.";
          case "recovered-stale-running":
            return "Sandbox recovered from stale running state and gateway ready.";
          case "created-or-restored":
            return "Sandbox started and gateway ready.";
          default: {
            const _exhaustive: never = result.readyAction;
            return `Unexpected readyAction: ${_exhaustive}`;
          }
        }
      });
      phases.push(ensurePhase);
      emitPhase(ensurePhase, true);

      if (ensurePhase.status === "pass") {
        emitRunning("chatCompletions");
        const chatPhase = await runPhase("chatCompletions", async () => {
          const gatewayUrl = await getSandboxDomain();
          const meta = await getInitializedMeta();
          const replyText = await runLaunchVerifyCompletion({
            gatewayUrl, gatewayToken: meta.gatewayToken,
            prompt: "Reply with exactly: launch-verify-ok",
            expectedText: "launch-verify-ok",
            requestTimeoutMs: 30_000,
          });
          return `Gateway replied with exact text: ${replyText}`;
        });
        phases.push(chatPhase);
        emitPhase(chatPhase, true);
      } else {
        const s = skipPhase("chatCompletions", "Skipped: sandbox not running.");
        phases.push(s);
        emitPhase(s, true);
      }

      if (mode === "destructive") {
        emitRunning("wakeFromSleep");
        const wakePhase = await runPhase("wakeFromSleep", async () => {
          await stopSandbox();
          const { probeId } = await publishLaunchVerifyQueueProbe({
            kind: "chat", origin,
            prompt: "Reply with exactly: wake-from-sleep-ok",
            expectedText: "wake-from-sleep-ok",
            sandboxReadyTimeoutMs: 120_000,
            requestTimeoutMs: 90_000,
          });
          const result = await waitForLaunchVerifyQueueResult(probeId, 180_000);
          if (!result.ok) {
            throw new Error(result.error ?? "Wake-from-sleep probe failed.");
          }
          return result.message;
        });
        phases.push(wakePhase);
        emitPhase(wakePhase, true);
      } else {
        const s = skipPhase("wakeFromSleep", "Not run in safe mode.");
        phases.push(s);
        emitPhase(s, true);
      }

      // Run dynamic config reconcile after ensure and before final payload.
      let configReconcile: DynamicConfigReconcileResult | null = null;
      let configReconcileError = false;
      if (ensurePhase.status === "pass") {
        try {
          configReconcile = await ensureRunningSandboxDynamicConfigFresh({
            origin,
          });
          logInfo("launch_verify.config_reconcile", {
            verified: configReconcile.verified,
            changed: configReconcile.changed,
            reason: configReconcile.reason,
          });
        } catch (error) {
          configReconcileError = true;
          logError("launch_verify.config_reconcile_error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let runtime: LaunchVerificationRuntime | undefined;
      let sandboxHealth: LaunchVerificationSandboxHealth | undefined;
      try {
        const runtimeMeta = await getInitializedMeta();
        runtime = buildLaunchVerificationRuntime(runtimeMeta);
        sandboxHealth = buildSandboxHealth({
          ensureReadyAction,
          configReconcile,
          configReconcileError,
        });
      } catch (error) {
        logInfo("launch_verify.runtime_metadata_unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const phasesOk = phases.every((p) => p.status === "pass" || p.status === "skip");
      // Stale config that could not be reconciled is a hard fail.
      const configFresh = ensurePhase.status !== "pass" ||
        (!configReconcileError && configReconcile !== null && configReconcile.verified);
      const ok = phasesOk && configFresh;
      const payload: LaunchVerificationPayload = {
        ok, mode, startedAt,
        completedAt: new Date().toISOString(),
        phases, diagnostics, runtime, sandboxHealth,
      };
      const readiness = await writeChannelReadiness(payload);

      logInfo(
        "launch_verify.completed",
        buildLaunchVerifyCompletionLog({ payload, readiness }),
      );

      emit({ type: "result", payload: { ...payload, channelReadiness: readiness } });
      controller.close();
    },
  });

  const headers: HeadersInit = {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (auth.setCookieHeader) {
    headers["Set-Cookie"] = auth.setCookieHeader;
  }

  return new Response(stream, { status: 200, headers });
}

async function buildJsonResponse(
  request: Request,
  auth: { setCookieHeader: string | null },
  mode: "safe" | "destructive",
  startedAt: string,
): Promise<Response> {
  const phases: LaunchVerificationPhase[] = [];

  const { phase: preflightPhase, blocking, diagnostics } = await evaluatePreflight(request);
  phases.push(preflightPhase);

  if (blocking.blocking) {
    for (const id of blocking.skipPhaseIds) {
      phases.push(skipPhase(id as LaunchVerificationPhaseId, "Skipped: preflight failed."));
    }
    const payload: LaunchVerificationPayload = {
      ok: false, mode, startedAt,
      completedAt: new Date().toISOString(), phases,
      diagnostics,
    };
    const readiness = await writeChannelReadiness(payload);
    return authJsonOk({ ...payload, channelReadiness: readiness }, auth);
  }

  const origin = getPublicOrigin(request);
  const queuePingPhase = await runPhase("queuePing", async () => {
    const { probeId, messageId } = await publishLaunchVerifyQueueProbe({
      kind: "ack", origin,
    });
    const result = await waitForLaunchVerifyQueueResult(probeId, 60_000);
    if (!result.ok) {
      throw new Error(result.error ?? "Queue delivery probe failed.");
    }
    return `Vercel Queue delivered callback ${messageId ?? "unknown"}.`;
  });
  phases.push(queuePingPhase);

  let ensureReadyAction: SandboxReadyAction | null = null;
  const ensurePhase = await runPhase("ensureRunning", async () => {
    const result = await waitForSandboxReady({
      origin, reason: "launch-verify",
      timeoutMs: ENSURE_TIMEOUT_MS, pollIntervalMs: ENSURE_POLL_MS,
      reconcile: true,
    });
    ensureReadyAction = result.readyAction;
    switch (result.readyAction) {
      case "already-running":
        return "Sandbox already running.";
      case "recovered-stale-running":
        return "Sandbox recovered from stale running state and gateway ready.";
      case "created-or-restored":
        return "Sandbox started and gateway ready.";
      default: {
        const _exhaustive: never = result.readyAction;
        return `Unexpected readyAction: ${_exhaustive}`;
      }
    }
  });
  phases.push(ensurePhase);

  if (ensurePhase.status === "pass") {
    const chatPhase = await runPhase("chatCompletions", async () => {
      const gatewayUrl = await getSandboxDomain();
      const meta = await getInitializedMeta();
      const replyText = await runLaunchVerifyCompletion({
        gatewayUrl, gatewayToken: meta.gatewayToken,
        prompt: "Reply with exactly: launch-verify-ok",
        expectedText: "launch-verify-ok",
        requestTimeoutMs: 30_000,
      });
      return `Gateway replied with exact text: ${replyText}`;
    });
    phases.push(chatPhase);
  } else {
    phases.push(skipPhase("chatCompletions", "Skipped: sandbox not running."));
  }

  if (mode === "destructive") {
    const wakePhase = await runPhase("wakeFromSleep", async () => {
      await stopSandbox();
      const { probeId } = await publishLaunchVerifyQueueProbe({
        kind: "chat", origin,
        prompt: "Reply with exactly: wake-from-sleep-ok",
        expectedText: "wake-from-sleep-ok",
        sandboxReadyTimeoutMs: 120_000,
        requestTimeoutMs: 90_000,
      });
      const result = await waitForLaunchVerifyQueueResult(probeId, 180_000);
      if (!result.ok) {
        throw new Error(result.error ?? "Wake-from-sleep probe failed.");
      }
      return result.message;
    });
    phases.push(wakePhase);
  } else {
    phases.push(skipPhase("wakeFromSleep", "Not run in safe mode."));
  }

  // Run dynamic config reconcile after ensure and before final payload.
  let configReconcile: DynamicConfigReconcileResult | null = null;
  let configReconcileError = false;
  if (ensurePhase.status === "pass") {
    try {
      configReconcile = await ensureRunningSandboxDynamicConfigFresh({
        origin,
      });
      logInfo("launch_verify.config_reconcile", {
        verified: configReconcile.verified,
        changed: configReconcile.changed,
        reason: configReconcile.reason,
      });
    } catch (error) {
      configReconcileError = true;
      logError("launch_verify.config_reconcile_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let runtime: LaunchVerificationRuntime | undefined;
  let sandboxHealth: LaunchVerificationSandboxHealth | undefined;
  try {
    const runtimeMeta = await getInitializedMeta();
    runtime = buildLaunchVerificationRuntime(runtimeMeta);
    sandboxHealth = buildSandboxHealth({
      ensureReadyAction,
      configReconcile,
      configReconcileError,
    });
  } catch (error) {
    logInfo("launch_verify.runtime_metadata_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const phasesOk = phases.every((p) => p.status === "pass" || p.status === "skip");
  // Stale config that could not be reconciled is a hard fail.
  const configFresh = ensurePhase.status !== "pass" ||
    (!configReconcileError && configReconcile !== null && configReconcile.verified);
  const ok = phasesOk && configFresh;
  const payload: LaunchVerificationPayload = {
    ok, mode, startedAt,
    completedAt: new Date().toISOString(),
    phases, diagnostics, runtime, sandboxHealth,
  };
  const readiness = await writeChannelReadiness(payload);

  logInfo(
    "launch_verify.completed",
    buildLaunchVerifyCompletionLog({ payload, readiness }),
  );

  return authJsonOk({ ...payload, channelReadiness: readiness }, auth);
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const readiness = await readChannelReadiness();
  return authJsonOk(readiness, auth);
}
