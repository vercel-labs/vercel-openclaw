import {
  authJsonOk,
  requireJsonRouteAuth,
  requireMutationAuth,
} from "@/server/auth/route-auth";
import { buildDeployPreflight } from "@/server/deploy-preflight";
import { logInfo, logError } from "@/server/log";
import { getPublicOrigin } from "@/server/public-url";
import {
  ensureSandboxRunning,
  getSandboxDomain,
  probeGatewayReady,
  stopSandbox,
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

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const startedAt = new Date().toISOString();

  // Mode resolution: query param takes precedence over JSON body.
  // Both `POST ?mode=destructive` and `POST { "mode": "destructive" }` are accepted.
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

  const phases: LaunchVerificationPhase[] = [];

  // Phase 1: preflight — only abort on config-check failures
  // (public-origin, webhook-bypass, store, ai-gateway).
  // Channel connectability is recorded but does NOT gate launch verification,
  // since channels depend on launch-verify having passed first.
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

  // If preflight fails, skip remaining phases
  if (preflightPhase.status === "fail") {
    phases.push(skipPhase("queuePing", "Skipped: preflight failed."));
    phases.push(skipPhase("ensureRunning", "Skipped: preflight failed."));
    phases.push(skipPhase("chatCompletions", "Skipped: preflight failed."));
    phases.push(skipPhase("wakeFromSleep", "Skipped: preflight failed."));
    const payload: LaunchVerificationPayload = {
      ok: false,
      mode,
      startedAt,
      completedAt: new Date().toISOString(),
      phases,
    };
    const readiness = await writeChannelReadiness(payload);
    return authJsonOk({ ...payload, channelReadiness: readiness }, auth);
  }

  // Phase 2: queuePing - publish a loopback probe through Vercel Queues
  const origin = getPublicOrigin(request);
  const queuePingPhase = await runPhase("queuePing", async () => {
    const { probeId, messageId } = await publishLaunchVerifyQueueProbe({
      kind: "ack",
      origin,
    });

    const result = await waitForLaunchVerifyQueueResult(probeId, 60_000);
    if (!result.ok) {
      throw new Error(result.error ?? "Queue delivery probe failed.");
    }

    return `Vercel Queue delivered callback ${messageId ?? "unknown"}.`;
  });
  phases.push(queuePingPhase);

  // Phase 3: ensureRunning
  const ensurePhase = await runPhase("ensureRunning", async () => {
    const result = await ensureSandboxRunning({
      origin,
      reason: "launch-verify",
    });

    if (result.state === "running") {
      return "Sandbox already running.";
    }

    // Poll until ready or timeout
    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ENSURE_POLL_MS));
      const meta = await getInitializedMeta();
      if (meta.status === "running" && meta.sandboxId) {
        const probe = await probeGatewayReady();
        if (probe.ready) {
          return "Sandbox started and gateway ready.";
        }
      }
      if (meta.status === "error") {
        throw new Error(`Sandbox entered error state: ${meta.lastError ?? "unknown"}`);
      }
    }
    const finalMeta = await getInitializedMeta();
    throw new Error(
      `Sandbox did not become ready within ${ENSURE_TIMEOUT_MS / 1000}s (status: ${finalMeta.status}).`,
    );
  });
  phases.push(ensurePhase);

  // Phase 4: chatCompletions - verify gateway responds with exact expected text.
  // Uses the same runLaunchVerifyCompletion() as the destructive wake path so
  // safe and destructive modes prove identical things.
  if (ensurePhase.status === "pass") {
    const chatPhase = await runPhase("chatCompletions", async () => {
      const gatewayUrl = await getSandboxDomain();
      const meta = await getInitializedMeta();

      const replyText = await runLaunchVerifyCompletion({
        gatewayUrl,
        gatewayToken: meta.gatewayToken,
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

  // Phase 5: wakeFromSleep (destructive only)
  if (mode === "destructive") {
    const wakePhase = await runPhase("wakeFromSleep", async () => {
      await stopSandbox();

      const { probeId } = await publishLaunchVerifyQueueProbe({
        kind: "chat",
        origin,
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

  // Build runtime info from stored metadata + env
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
    // sandboxHealth.repaired is true when ensure had to start/restore the sandbox
    // rather than finding it already running.
    sandboxHealth = {
      repaired: ensurePhase.status === "pass" &&
        ensurePhase.message !== "Sandbox already running.",
    };
  } catch {
    // Non-fatal — runtime and health info is best-effort
  }

  const ok = phases.every((p) => p.status === "pass" || p.status === "skip");
  const payload: LaunchVerificationPayload = {
    ok,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    phases,
    runtime,
    sandboxHealth,
  };

  const readiness = await writeChannelReadiness(payload);

  logInfo("launch_verify.completed", {
    ok: payload.ok,
    mode: payload.mode,
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
