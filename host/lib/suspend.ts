import type { Sandbox } from '@vercel/sandbox';

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

export interface SuspendReady {
  status: 'ready';
  suspensionId: string;
  expiresAtMs: number;
  activeCount: number;
  blockers: string[];
}

export interface SuspendBusy {
  status: 'busy';
  reason: 'active-work' | 'gateway-draining';
  retryAfterMs: number; // 20_000 in beta.7
  activeCount: number;
  blockers: string[];
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
 * Call gateway methods by running OpenClaw's own CLI inside the sandbox
 * (`openclaw gateway call <method> --json`). Avoids reimplementing the
 * gateway's WebSocket protocol in the host; requires the sandbox awake,
 * which is always true when suspension is being negotiated.
 */
export function createSandboxGatewayCaller(
  sandbox: Sandbox,
  token: string,
  port = 3000,
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
        '--token',
        token,
        '--json',
        '--params',
        JSON.stringify(params),
      ],
    });
    const stdout = await result.stdout();
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(
        `gateway call ${method} returned non-JSON (exit ${result.exitCode}): ${stdout.slice(0, 300)}`,
      );
    }
  };
}

/**
 * Normalize a raw `gateway call` response into a PrepareResult. Success
 * payloads carry a status field; the conflict case arrives as an UNAVAILABLE
 * error with reason "gateway-suspension-conflict" (verified shape).
 */
export function normalizePrepareResponse(raw: unknown): PrepareResult {
  const value = raw as Record<string, any>;
  if (value?.status === 'ready' || value?.status === 'busy' || value?.status === 'recovering') {
    return value as PrepareResult;
  }
  const details = value?.error?.details ?? value?.details;
  if (details?.reason === 'gateway-suspension-conflict') {
    return { status: 'conflict', expiresAtMs: details.expiresAtMs ?? 0 };
  }
  if (details?.reason === 'scheduler-resume-failed' || value?.error?.retryAfterMs) {
    return { status: 'recovering', retryAfterMs: value?.error?.retryAfterMs ?? 1_000 };
  }
  throw new Error(`unrecognized gateway.suspend.prepare response: ${JSON.stringify(raw).slice(0, 300)}`);
}

// ---- decision logic (pure) ----

export type SuspendAction =
  | { action: 'stop'; suspensionId: string; leaseExpiresAtMs: number }
  | { action: 'force-stop'; reason: string }
  | { action: 'rearm'; nextCheckAtMs: number; blockers: string[] }
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
            reason: `ceiling reached while busy (${result.reason}: ${result.blockers.join(', ')})`,
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
        nextRetryAtMs: Math.min(result.expiresAtMs, now + 30_000),
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
  const decision = decideSuspendAction(normalizePrepareResponse(raw), now(), options);
  if (decision.action === 'stop' || decision.action === 'force-stop') {
    await deps.stop();
  }
  return decision;
}

/** Cancel a HELD lease (host changed its mind after ready, before stop). */
export async function cancelSuspend(call: GatewayCaller, suspensionId: string): Promise<void> {
  await call('gateway.suspend.resume', { suspensionId });
}
