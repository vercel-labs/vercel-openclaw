import {
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { buildDeployPreflight } from "@/server/deploy-preflight";
import { logInfo, logError } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  getSandboxDomain,
  stopSandbox,
  waitForSandboxReady,
  type SandboxReadyAction,
} from "@/server/sandbox/lifecycle";
import { getOpenclawPackageSpec } from "@/server/env";
import { detectDrift } from "@/server/openclaw/bootstrap";
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
  LaunchVerificationPayload,
  LaunchVerificationPhase,
  LaunchVerificationPhaseId,
  LaunchVerificationRuntime,
  LaunchVerificationSandboxHealth,
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
  logInfo(`launch_verify.phase_skip`, { phase: id });
  return { id, status: "skip", durationMs: 0, message };
}

// NDJSON stream event types
type StreamPhaseEvent = { type: "phase"; phase: LaunchVerificationPhase };
type StreamResultEvent = {
  type: "result";
  payload: LaunchVerificationPayload & { channelReadiness?: import("@/shared/launch-verification").ChannelReadiness };
};
type StreamEvent = StreamPhaseEvent | StreamResultEvent;

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
      function emit(event: StreamEvent): void {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }

      function emitRunning(id: LaunchVerificationPhaseId): void {
        emit({ type: "phase", phase: { id, status: "running", durationMs: 0, message: "Running\u2026" } });
      }

      const phases: LaunchVerificationPhase[] = [];

      emitRunning("preflight");
      const preflightPhase = await runPhase("preflight", async () => {
        const preflight = await buildDeployPreflight(request);
        const configCheckFailures = preflight.checks.filter(
          (c) => c.status === "fail",
        );
        if (configCheckFailures.length > 0) {
          const failingIds = configCheckFailures.map((c) => c.id);
          const failingActions = preflight.actions
            .filter((a) => a.status === "required")
            .map((a) => a.remediation);
          throw new Error(
            `Preflight config checks failed: ${failingIds.join(", ")}. ${failingActions.join(" ")}`,
          );
        }
        const channelWarnings = Object.values(preflight.channels ?? {}).filter(
          (ch) => ch.status === "fail",
        );
        if (channelWarnings.length > 0) {
          logInfo("launch_verify.preflight_channel_warnings", {
            channels: channelWarnings.map((ch) => ch.channel),
          });
        }
        return `All ${preflight.checks.length} config checks passed.`;
      });
      phases.push(preflightPhase);
      emit({ type: "phase", phase: preflightPhase });

      if (preflightPhase.status === "fail") {
        const skips: LaunchVerificationPhaseId[] = ["queuePing", "ensureRunning", "chatCompletions", "wakeFromSleep"];
        for (const id of skips) {
          const s = skipPhase(id, "Skipped: preflight failed.");
          phases.push(s);
          emit({ type: "phase", phase: s });
        }

        const payload: LaunchVerificationPayload = {
          ok: false, mode, startedAt,
          completedAt: new Date().toISOString(), phases,
        };
        const readiness = await writeChannelReadiness(payload);
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
      emit({ type: "phase", phase: queuePingPhase });

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
      emit({ type: "phase", phase: ensurePhase });

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
        emit({ type: "phase", phase: chatPhase });
      } else {
        const s = skipPhase("chatCompletions", "Skipped: sandbox not running.");
        phases.push(s);
        emit({ type: "phase", phase: s });
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
        emit({ type: "phase", phase: wakePhase });
      } else {
        const s = skipPhase("wakeFromSleep", "Not run in safe mode.");
        phases.push(s);
        emit({ type: "phase", phase: s });
      }

      let runtime: LaunchVerificationRuntime | undefined;
      let sandboxHealth: LaunchVerificationSandboxHealth | undefined;
      try {
        const runtimeMeta = await getInitializedMeta();
        const packageSpec = getOpenclawPackageSpec();
        if (packageSpec) {
          runtime = {
            packageSpec,
            installedVersion: runtimeMeta.openclawVersion,
            drift: detectDrift(packageSpec, runtimeMeta.openclawVersion),
          };
        }
        sandboxHealth = {
          repaired: ensureReadyAction !== null &&
            ensureReadyAction !== "already-running",
        };
      } catch {
        // Non-fatal
      }

      const ok = phases.every((p) => p.status === "pass" || p.status === "skip");
      const payload: LaunchVerificationPayload = {
        ok, mode, startedAt,
        completedAt: new Date().toISOString(),
        phases, runtime, sandboxHealth,
      };
      const readiness = await writeChannelReadiness(payload);

      logInfo("launch_verify.completed", {
        ok: payload.ok, mode: payload.mode,
        phaseCount: payload.phases.length,
        totalMs: Date.now() - new Date(startedAt).getTime(),
        channelReady: readiness.ready,
      });

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

  const preflightPhase = await runPhase("preflight", async () => {
    const preflight = await buildDeployPreflight(request);
    const configCheckFailures = preflight.checks.filter(
      (c) => c.status === "fail",
    );
    if (configCheckFailures.length > 0) {
      const failingIds = configCheckFailures.map((c) => c.id);
      const failingActions = preflight.actions
        .filter((a) => a.status === "required")
        .map((a) => a.remediation);
      throw new Error(
        `Preflight config checks failed: ${failingIds.join(", ")}. ${failingActions.join(" ")}`,
      );
    }
    const channelWarnings = Object.values(preflight.channels ?? {}).filter(
      (ch) => ch.status === "fail",
    );
    if (channelWarnings.length > 0) {
      logInfo("launch_verify.preflight_channel_warnings", {
        channels: channelWarnings.map((ch) => ch.channel),
      });
    }
    return `All ${preflight.checks.length} config checks passed.`;
  });
  phases.push(preflightPhase);

  if (preflightPhase.status === "fail") {
    phases.push(skipPhase("queuePing", "Skipped: preflight failed."));
    phases.push(skipPhase("ensureRunning", "Skipped: preflight failed."));
    phases.push(skipPhase("chatCompletions", "Skipped: preflight failed."));
    phases.push(skipPhase("wakeFromSleep", "Skipped: preflight failed."));
    const payload: LaunchVerificationPayload = {
      ok: false, mode, startedAt,
      completedAt: new Date().toISOString(), phases,
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

  let runtime: LaunchVerificationRuntime | undefined;
  let sandboxHealth: LaunchVerificationSandboxHealth | undefined;
  try {
    const runtimeMeta = await getInitializedMeta();
    const packageSpec = getOpenclawPackageSpec();
    if (packageSpec) {
      runtime = {
        packageSpec,
        installedVersion: runtimeMeta.openclawVersion,
        drift: detectDrift(packageSpec, runtimeMeta.openclawVersion),
      };
    }
    sandboxHealth = {
      repaired: ensureReadyAction !== null &&
        ensureReadyAction !== "already-running",
    };
  } catch {
    // Non-fatal
  }

  const ok = phases.every((p) => p.status === "pass" || p.status === "skip");
  const payload: LaunchVerificationPayload = {
    ok, mode, startedAt,
    completedAt: new Date().toISOString(),
    phases, runtime, sandboxHealth,
  };
  const readiness = await writeChannelReadiness(payload);

  logInfo("launch_verify.completed", {
    ok: payload.ok, mode: payload.mode,
    phaseCount: payload.phases.length,
    totalMs: Date.now() - new Date(startedAt).getTime(),
    channelReady: readiness.ready,
  });

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
