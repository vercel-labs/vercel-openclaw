import type { Sandbox } from '@vercel/sandbox';
import { GATEWAY_PORT } from './wake';

/**
 * Suspend logic per docs/suspension-spec.md, "Contract facts, VERIFIED
 * 2026-08-10" (read from OpenClaw 2026.7.2-beta.7's shipped code).
 *
 * gateway.suspend.prepare is an idle-fence acquire, NOT a drain request:
 * it returns ready only when tracked gateway work (cron runs, chat runs,
 * queued turns, terminal sessions) is idle. While held it pauses cron
 * scheduling, so ready MUST be followed by stop() within seconds — the lease
 * is exactly 2 minutes and auto-expires. Never renew on a timer.
 */

// ---- gateway.suspend.prepare result shapes (verified) ----

/**
 * Live shape observed 2026-08-11 (beta.7): structured objects, e.g.
 * {kind: "chat-run", count: 1, message: "1 active chat run(s)"}, with an
 * extended form for tasks. Kept loose; the host only logs them.
 */
export interface SuspendBlocker {
  kind: string;
  count?: number;
  message?: string;
  [key: string]: unknown;
}

export interface SuspendReady {
  status: 'ready';
  suspensionId: string;
  expiresAtMs: number;
  activeCount: number;
  blockers: SuspendBlocker[];
}

export interface SuspendBusy {
  status: 'busy';
  reason: 'active-work' | 'gateway-draining';
  retryAfterMs: number; // 20_000 in beta.7
  activeCount: number;
  blockers: SuspendBlocker[];
}

/** A different requestId already holds the lease (arrives as an RPC error). */
export interface SuspendConflict {
  status: 'conflict';
  expiresAtMs: number;
}

export interface SuspendRecovering {
  status: 'recovering';
  retryAfterMs: number;
}

export type PrepareResult =
  | SuspendReady
  | SuspendBusy
  | SuspendConflict
  | SuspendRecovering;

// ---- transport ----

export type GatewayCaller = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * The targeted gateway predates the suspension API (< 2026.7.2). Observed
 * live 2026-08-11 against 2026.7.1: {ok:false, error:{type:
 * "gateway_request_error", code:"INVALID_REQUEST", message:"unknown method:
 * gateway.suspend.prepare", retryable:false}}. Hosts should disable the idle
 * path and rely on the platform-timeout backstop.
 */
export class GatewaySuspendUnsupportedError extends Error {
  constructor(method: string) {
    super(`gateway does not support ${method} (predates OpenClaw 2026.7.2)`);
    this.name = 'GatewaySuspendUnsupportedError';
  }
}

/**
 * Call gateway methods by running OpenClaw's own CLI inside the sandbox
 * (`openclaw gateway call <method> --json`). Avoids reimplementing the
 * gateway's WebSocket protocol in the host; requires the sandbox awake,
 * which is always true when suspension is being negotiated.
 */
export function createSandboxGatewayCaller(
  sandbox: Sandbox,
  token: string,
  port = GATEWAY_PORT,
): GatewayCaller {
  return async (method, params) => {
    const result = await sandbox.runCommand({
      cmd: 'openclaw',
      args: [
        'gateway',
        'call',
        method,
        '--url',
        `ws://127.0.0.1:${port}`,
        // --token must be explicit: with a --url override the CLI refuses
        // env-only credentials (verified live 2026-08-11). argv visibility
        // is acceptable in a single-tenant VM.
        '--token',
        token,
        '--json',
        '--params',
        JSON.stringify(params),
      ],
    });
    // RPC-level failures (e.g. the conflict error) may exit non-zero and
    // print the error JSON on either stream; try both before giving up so
    // error shapes still reach normalizePrepareResponse. The exact CLI error
    // format is only partially verified (see spec, open questions).
    const stdout = await result.stdout();
    const stderr = await result.stderr();
    for (const output of [stdout, stderr]) {
      const trimmed = output.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // fall through to the next stream / the final error
      }
      // The CLI wraps transport failures (gateway unreachable, socket
      // closed) in {ok:false, error:{...}} ON STDOUT with valid JSON.
      // Verified live 2026-08-11: treating that envelope as a result made
      // resume report success against a dead listener. Throw instead.
      const envelope = parsed as { ok?: boolean; error?: { type?: string; message?: string } };
      if (envelope?.ok === false && envelope.error) {
        if (
          method.startsWith('gateway.suspend.') &&
          envelope.error.message?.startsWith('unknown method')
        ) {
          throw new GatewaySuspendUnsupportedError(method);
        }
        throw new Error(
          `gateway call ${method} transport error: ${envelope.error.type ?? 'unknown'}: ${envelope.error.message ?? ''}`,
        );
      }
      return parsed;
    }
    throw new Error(
      `gateway call ${method} returned no JSON (exit ${result.exitCode}): ${(stdout || stderr).slice(0, 300)}`,
    );
  };
}

/**
 * Normalize a raw `gateway call` response into a PrepareResult. Success
 * payloads carry a status field; the conflict case arrives as an UNAVAILABLE
 * error with reason "gateway-suspension-conflict" (verified shape).
 */
export function normalizePrepareResponse(raw: unknown, nowMs: number = Date.now()): PrepareResult {
  const value = raw as Record<string, unknown>;
  const error =
    value?.error && typeof value.error === 'object'
      ? (value.error as Record<string, unknown>)
      : undefined;
  // Validate per branch: this JSON comes from an external process, and a
  // malformed "ready" must never be allowed to stop the sandbox.
  if (value?.status === 'ready') {
    if (typeof value.suspensionId !== 'string' || typeof value.expiresAtMs !== 'number') {
      throw new Error(
        `malformed ready response (missing suspensionId/expiresAtMs): ${JSON.stringify(raw).slice(0, 300)}`,
      );
    }
    return { ...value, blockers: value.blockers ?? [] } as SuspendReady;
  }
  if (value?.status === 'busy') {
    return {
      ...value,
      reason: value.reason ?? 'active-work',
      retryAfterMs: typeof value.retryAfterMs === 'number' ? value.retryAfterMs : 20_000,
      blockers: Array.isArray(value.blockers) ? value.blockers : [],
    } as SuspendBusy;
  }
  if (value?.status === 'recovering') {
    return {
      status: 'recovering',
      retryAfterMs: typeof value.retryAfterMs === 'number' ? value.retryAfterMs : 1_000,
    };
  }
  const rawDetails = error?.details ?? value?.details;
  const details =
    rawDetails && typeof rawDetails === 'object'
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  if (details?.reason === 'gateway-suspension-conflict') {
    return {
      status: 'conflict',
      expiresAtMs: typeof details.expiresAtMs === 'number' ? details.expiresAtMs : nowMs + 30_000,
    };
  }
  // Scheduler recovery can also surface as an UNAVAILABLE error
  // (schedulerRecoveryError in the verified beta.7 handler).
  if (details?.reason === 'scheduler-resume-failed' || typeof error?.retryAfterMs === 'number') {
    return {
      status: 'recovering',
      retryAfterMs: typeof error?.retryAfterMs === 'number' ? error.retryAfterMs : 1_000,
    };
  }
  throw new Error(`unrecognized gateway.suspend.prepare response: ${JSON.stringify(raw).slice(0, 300)}`);
}

// ---- decision logic (pure) ----

export type SuspendAction =
  | { action: 'stop'; suspensionId: string; leaseExpiresAtMs: number }
  | { action: 'force-stop'; reason: string }
  | { action: 'rearm'; nextCheckAtMs: number; blockers: SuspendBlocker[] }
  | { action: 'retry'; nextRetryAtMs: number; reason: string };

export const IDLE_REARM_MS = 15 * 60 * 1000;

/**
 * Decide what the host does with one prepare result.
 *
 * Idle path (no deadline): ready -> stop; busy -> the gateway is working,
 * treat as activity and re-arm +15 min. Nothing is held on busy, so no
 * resume call is needed.
 *
 * Ceiling path (hard deadline approaching): busy -> retry every retryAfterMs;
 * at forceStopAtMs stop anyway. A forced stop equals what the platform would
 * do at the deadline; the disk snapshot is taken either way.
 */
export function decideSuspendAction(
  result: PrepareResult,
  now: number,
  options: { ceiling?: { forceStopAtMs: number } } = {},
): SuspendAction {
  switch (result.status) {
    case 'ready':
      return {
        action: 'stop',
        suspensionId: result.suspensionId,
        leaseExpiresAtMs: result.expiresAtMs,
      };
    case 'busy': {
      if (options.ceiling) {
        if (now >= options.ceiling.forceStopAtMs) {
          return {
            action: 'force-stop',
            reason: `ceiling reached while busy (${result.reason}: ${result.blockers.map((b) => b.message ?? b.kind).join(', ')})`,
          };
        }
        return {
          action: 'retry',
          nextRetryAtMs: now + result.retryAfterMs,
          reason: `busy: ${result.reason}`,
        };
      }
      return {
        action: 'rearm',
        nextCheckAtMs: now + IDLE_REARM_MS,
        blockers: result.blockers,
      };
    }
    case 'conflict':
      // Another suspension holds the fence; it self-expires within 2 min.
      return {
        action: 'retry',
        nextRetryAtMs: Math.min(Math.max(result.expiresAtMs, now), now + 30_000),
        reason: 'different requestId holds the lease',
      };
    case 'recovering':
      return {
        action: 'retry',
        nextRetryAtMs: now + result.retryAfterMs,
        reason: 'gateway scheduler recovering',
      };
  }
}

// ---- one full suspend attempt ----

export interface SuspendAttemptDeps {
  call: GatewayCaller;
  /** Stops the sandbox session; the platform snapshots the disk. */
  stop: () => Promise<void>;
  requestId: string;
  now?: () => number;
}

/**
 * Run one suspend attempt end to end: prepare, decide, and on ready stop
 * immediately (the 2-minute lease starts at ready). Returns the action taken
 * so the host cron can schedule its next check.
 */
export async function attemptSuspend(
  deps: SuspendAttemptDeps,
  options: { ceiling?: { forceStopAtMs: number } } = {},
): Promise<SuspendAction> {
  const now = deps.now ?? Date.now;
  const raw = await deps.call('gateway.suspend.prepare', { requestId: deps.requestId });
  const decision = decideSuspendAction(normalizePrepareResponse(raw, now()), now(), options);
  if (decision.action === 'stop') {
    try {
      await deps.stop();
    } catch (err) {
      // A failed stop leaves the lease HELD with gateway cron paused; release
      // it instead of letting it burn its full 2-minute TTL.
      try {
        await cancelSuspend(deps.call, decision.suspensionId);
      } catch {
        // lease self-expires within 2 minutes; nothing better to do
      }
      throw err;
    }
  } else if (decision.action === 'force-stop') {
    await deps.stop();
  }
  return decision;
}

/** Cancel a HELD lease (host changed its mind after ready, before stop). */
export async function cancelSuspend(call: GatewayCaller, suspensionId: string): Promise<void> {
  await call('gateway.suspend.resume', { suspensionId });
}
