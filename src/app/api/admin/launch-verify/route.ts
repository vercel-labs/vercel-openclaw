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
  prepareRestoreTarget,
  probeGatewayReady,
  stopSandbox,
  waitForSandboxReady,
  type DynamicConfigReconcileResult,
  type SandboxReadyAction,
} from "@/server/sandbox/lifecycle";
import { getOpenclawPackageSpec } from "@/server/env";
import { detectDrift } from "@/server/openclaw/bootstrap";
import {
  buildRestoreTargetAttestation,
  buildRestoreTargetPlan,
} from "@/server/sandbox/restore-attestation";
import {
  runRestoreOracleCycle,
} from "@/server/sandbox/restore-oracle";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import {
  type LaunchVerifyQueueResult,
} from "@/server/launch-verify/queue-probe";
import * as launchVerifyQueueProbe from "@/server/launch-verify/queue-probe";
import {
  readChannelReadiness,
  writeChannelReadiness,
} from "@/server/launch-verify/state";
import {
  buildRestorePreparedPhaseEvidence,
  type ChannelReadiness,
  type LaunchVerificationDiagnostics,
  type LaunchVerificationPayload,
  type LaunchVerificationPhase,
  type LaunchVerificationPhaseCode,
  type LaunchVerificationPhaseDetails,
  type LaunchVerificationPhaseId,
  type LaunchVerificationRuntime,
  type LaunchVerificationSandboxHealth,
  type LaunchVerificationStreamEvent,
  type LaunchVerifyCompletionLog,
  type RestorePreparedPhaseResolutionCode,
} from "@/shared/launch-verification";

const ENSURE_POLL_MS = 2_000;
const ENSURE_TIMEOUT_MS = 120_000;

type LaunchVerifyQueueProbeAdapter = Pick<
  typeof launchVerifyQueueProbe,
  "publishLaunchVerifyQueueProbe" | "waitForLaunchVerifyQueueResult"
>;

let launchVerifyQueueProbeAdapter: LaunchVerifyQueueProbeAdapter =
  launchVerifyQueueProbe;

export function __setLaunchVerifyQueueProbeAdapterForTests(
  adapter: LaunchVerifyQueueProbeAdapter | null,
): void {
  if (process.env.NODE_ENV !== "test") return;
  launchVerifyQueueProbeAdapter = adapter ?? launchVerifyQueueProbe;
}

type PhaseExecutionValue =
  | string
  | {
      ok?: boolean;
      message: string;
      error?: string;
      code?: LaunchVerificationPhaseCode;
      details?: LaunchVerificationPhaseDetails;
    };

type NormalizedPhaseExecutionValue = {
  ok: boolean;
  message: string;
  error?: string;
  code?: LaunchVerificationPhaseCode;
  details?: LaunchVerificationPhaseDetails;
};

function normalizePhaseExecutionValue(
  value: PhaseExecutionValue,
): NormalizedPhaseExecutionValue {
  if (typeof value === "string") {
    return { ok: true, message: value, code: "phase.pass" };
  }
  return {
    ok: value.ok ?? true,
    message: value.message,
    error: value.error,
    code: value.code,
    details: value.details,
  };
}

function summarizePhaseDetailsForLog(
  details: LaunchVerificationPhaseDetails | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  switch (details.kind) {
    case "restorePrepared":
      return {
        resolutionCode: details.resolution.code,
        blockedReason: details.blockedReason,
        initialReusable: details.initialAttestation.reusable,
        finalReusable: details.finalAttestation.reusable,
        prepareOk: details.prepare?.ok ?? null,
        snapshotId: details.prepare?.snapshotId ?? null,
        restorePlanActionIds: details.plan.actions.map((a) => a.id),
        restoreReasonIds: details.finalAttestation.reasons,
      };
    default:
      return undefined;
  }
}

function toRestorePreparedPhaseCode(
  code: RestorePreparedPhaseResolutionCode,
): LaunchVerificationPhaseCode {
  switch (code) {
    case "already-reusable":
      return "restorePrepared.already-reusable";
    case "prepared":
      return "restorePrepared.prepared";
    case "blocked":
      return "restorePrepared.blocked";
    case "prepare-failed":
      return "restorePrepared.prepare-failed";
    case "not-reusable-after-prepare":
      return "restorePrepared.not-reusable-after-prepare";
  }
}

async function runPhase(
  id: LaunchVerificationPhaseId,
  fn: () => Promise<PhaseExecutionValue>,
): Promise<LaunchVerificationPhase> {
  const startedAt = Date.now();
  try {
    const result = normalizePhaseExecutionValue(await fn());
    const phase: LaunchVerificationPhase = {
      id,
      status: result.ok ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      message: result.message,
      ...(result.error ? { error: result.error } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
    const logFields = {
      phase: id,
      durationMs: phase.durationMs,
      code: phase.code ?? (phase.status === "pass" ? "phase.pass" : "phase.fail"),
      ...(summarizePhaseDetailsForLog(phase.details) ?? {}),
    };
    if (phase.status === "fail") {
      logError("launch_verify.phase_fail", {
        ...logFields,
        error: phase.error ?? phase.message,
      });
    } else {
      logInfo("launch_verify.phase_pass", logFields);
    }
    return phase;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const phase: LaunchVerificationPhase = {
      id,
      status: "fail",
      durationMs: Date.now() - startedAt,
      message: `Phase ${id} failed.`,
      error: message,
      code: "phase.fail",
    };
    logError("launch_verify.phase_fail", {
      phase: id,
      durationMs: phase.durationMs,
      code: phase.code,
      error: message,
    });
    return phase;
  }
}

function skipPhase(id: LaunchVerificationPhaseId, message: string): LaunchVerificationPhase {
  const phase: LaunchVerificationPhase = {
    id,
    status: "skip",
    durationMs: 0,
    message,
    code: "phase.skip",
  };
  logInfo("launch_verify.phase_skip", { phase: id, code: phase.code, message });
  return phase;
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
  const attestation = input.payload.runtime?.restoreAttestation;
  const plan = input.payload.runtime?.restorePlan;

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
    restoreReusable: attestation?.reusable ?? null,
    restoreNeedsPrepare: attestation?.needsPrepare ?? null,
    restoreReasonIds: attestation?.reasons ?? [],
    restorePlanActionIds: plan?.actions.map((a) => a.id) ?? [],
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

function buildQueueProbeFailureMessage(
  result: LaunchVerifyQueueResult,
  fallback: string,
): string {
  const suffix = result.error ? ` ${result.error}` : "";
  return `${result.message}${suffix}`.trim() || fallback;
}

// ---------------------------------------------------------------------------
// Shared restore-prepared verification — used by both JSON and NDJSON paths
// ---------------------------------------------------------------------------

async function runRestorePreparedVerification(input: {
  origin: string;
  reason: string;
}): Promise<PhaseExecutionValue> {
  const oracle = await runRestoreOracleCycle(
    {
      origin: input.origin,
      reason: input.reason,
      force: true,
      minIdleMs: 0,
    },
    {
      getMeta: getInitializedMeta,
      mutate: mutateMeta,
      probe: probeGatewayReady,
      prepare: prepareRestoreTarget,
      now: () => Date.now(),
    },
  );

  const finalMeta = await getInitializedMeta();
  const finalAttestation = buildRestoreTargetAttestation(finalMeta);
  const plan = buildRestoreTargetPlan({
    attestation: finalAttestation,
    status: finalMeta.status,
    sandboxId: finalMeta.sandboxId,
  });

  const evidence = buildRestorePreparedPhaseEvidence({
    blockedReason: oracle.blockedReason,
    initialAttestation: oracle.attestation,
    finalAttestation,
    plan,
    prepare: oracle.prepare
      ? {
          ok: oracle.prepare.ok,
          snapshotId: oracle.prepare.snapshotId,
          actions: oracle.prepare.actions,
        }
      : null,
  });

  logInfo("launch_verify.restore_prepared_resolution", {
    code: evidence.resolution.code,
    ok: evidence.resolution.ok,
    blockedReason: evidence.blockedReason,
    message: evidence.resolution.message,
    prepareOk: evidence.prepare?.ok ?? null,
    snapshotId: evidence.prepare?.snapshotId ?? null,
    initialReusable: evidence.initialAttestation.reusable,
    finalReusable: evidence.finalAttestation.reusable,
    restorePlanActionIds: evidence.plan.actions.map((a) => a.id),
    restoreReasonIds: evidence.finalAttestation.reasons,
  });

  return {
    ok: evidence.resolution.ok,
    message: evidence.resolution.message,
    error: evidence.resolution.ok ? undefined : evidence.resolution.message,
    code: toRestorePreparedPhaseCode(evidence.resolution.code),
    details: evidence,
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

  const attestation = buildRestoreTargetAttestation(runtimeMeta);
  const plan = buildRestoreTargetPlan({
    attestation,
    status: runtimeMeta.status,
    sandboxId: runtimeMeta.sandboxId,
  });

  return {
    packageSpec,
    installedVersion: runtimeMeta.openclawVersion,
    drift: detectDrift(packageSpec, runtimeMeta.openclawVersion),
    expectedConfigHash: attestation.desiredDynamicConfigHash,
    lastRestoreConfigHash: runtimeMeta.lastRestoreMetrics?.dynamicConfigHash ?? null,
    dynamicConfigVerified:
      runtimeMeta.lastRestoreMetrics?.dynamicConfigHash == null
        ? null
        : runtimeMeta.lastRestoreMetrics.dynamicConfigHash ===
          attestation.desiredDynamicConfigHash,
    dynamicConfigReason: runtimeMeta.lastRestoreMetrics?.dynamicConfigReason,
    restorePreparedStatus: runtimeMeta.restorePreparedStatus,
    restorePreparedReason: runtimeMeta.restorePreparedReason,
    snapshotDynamicConfigHash: runtimeMeta.snapshotDynamicConfigHash,
    runtimeDynamicConfigHash: runtimeMeta.runtimeDynamicConfigHash,
    snapshotAssetSha256: runtimeMeta.snapshotAssetSha256,
    runtimeAssetSha256: runtimeMeta.runtimeAssetSha256,
    restoreAttestation: attestation,
    restorePlan: plan,
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
        const { probeId, messageId } = await launchVerifyQueueProbeAdapter.publishLaunchVerifyQueueProbe({
          kind: "ack", origin,
        });
        const result = await launchVerifyQueueProbeAdapter.waitForLaunchVerifyQueueResult(
          probeId,
          60_000,
        );
        if (!result.ok) {
          throw new Error(
            buildQueueProbeFailureMessage(result, "Queue delivery probe failed."),
          );
        }
        return `${result.message} Callback message ID: ${messageId ?? "unknown"}.`;
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
          const replyText = await launchVerifyQueueProbe.runLaunchVerifyCompletion({
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
          const { probeId } = await launchVerifyQueueProbeAdapter.publishLaunchVerifyQueueProbe({
            kind: "chat", origin,
            prompt: "Reply with exactly: wake-from-sleep-ok",
            expectedText: "wake-from-sleep-ok",
            sandboxReadyTimeoutMs: 120_000,
            requestTimeoutMs: 90_000,
          });
          const result = await launchVerifyQueueProbeAdapter.waitForLaunchVerifyQueueResult(
            probeId,
            180_000,
          );
          if (!result.ok) {
            throw new Error(
              buildQueueProbeFailureMessage(result, "Wake-from-sleep probe failed."),
            );
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

      // Restore prepare: seal a fresh restore target in destructive mode
      if (mode === "destructive") {
        emitRunning("restorePrepared");
        const restorePreparedPhase = await runPhase("restorePrepared", () =>
          runRestorePreparedVerification({
            origin,
            reason: "launch-verify:restore-prepare",
          }),
        );
        phases.push(restorePreparedPhase);
        emitPhase(restorePreparedPhase, true);
      } else {
        const s = skipPhase("restorePrepared", "Not run in safe mode.");
        phases.push(s);
        emitPhase(s, true);
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
    const { probeId, messageId } = await launchVerifyQueueProbeAdapter.publishLaunchVerifyQueueProbe({
      kind: "ack", origin,
    });
    const result = await launchVerifyQueueProbeAdapter.waitForLaunchVerifyQueueResult(
      probeId,
      60_000,
    );
    if (!result.ok) {
      throw new Error(
        buildQueueProbeFailureMessage(result, "Queue delivery probe failed."),
      );
    }
    return `${result.message} Callback message ID: ${messageId ?? "unknown"}.`;
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
      const replyText = await launchVerifyQueueProbe.runLaunchVerifyCompletion({
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
      const { probeId } = await launchVerifyQueueProbeAdapter.publishLaunchVerifyQueueProbe({
        kind: "chat", origin,
        prompt: "Reply with exactly: wake-from-sleep-ok",
        expectedText: "wake-from-sleep-ok",
        sandboxReadyTimeoutMs: 120_000,
        requestTimeoutMs: 90_000,
      });
      const result = await launchVerifyQueueProbeAdapter.waitForLaunchVerifyQueueResult(
        probeId,
        180_000,
      );
      if (!result.ok) {
        throw new Error(
          buildQueueProbeFailureMessage(result, "Wake-from-sleep probe failed."),
        );
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

  // Restore prepare: seal a fresh restore target in destructive mode
  if (mode === "destructive") {
    const restorePreparedPhase = await runPhase("restorePrepared", () =>
      runRestorePreparedVerification({
        origin,
        reason: "launch-verify:restore-prepare",
      }),
    );
    phases.push(restorePreparedPhase);
  } else {
    phases.push(skipPhase("restorePrepared", "Not run in safe mode."));
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
