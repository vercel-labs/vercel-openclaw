import { NextRequest, NextResponse } from 'next/server';
import { APIError, Sandbox } from '@vercel/sandbox';
import { defaultActivityStore } from '@/lib/activity-store';
import { isIdle, IDLE_THRESHOLD_MS } from '@/lib/activity';
import { attemptSuspend, createSandboxGatewayCaller, IDLE_REARM_MS } from '@/lib/suspend';
import { startGateway } from '@/lib/wake';

/**
 * The lifecycle scheduler per docs/suspension-spec.md: runs every 5 minutes
 * (vercel.json crons). Two paths:
 *
 * - Idle: 60 minutes without host-visible activity -> suspend attempt. The
 *   timer only initiates; gateway.suspend.prepare is the correctness gate.
 * - Ceiling: the session deadline is near and can no longer be extended ->
 *   suspend attempt with force-stop at T-60s. A forced stop equals what the
 *   platform would do anyway; the disk snapshot is taken either way.
 */

// Must cover the in-request ceiling loop: up to CEILING_WINDOW_MS of
// re-prepare attempts before the force-stop margin.
export const maxDuration = 300;

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';
const CEILING_WINDOW_MS = 5 * 60 * 1000;
const CEILING_FORCE_STOP_MARGIN_MS = 60 * 1000;

// Stable across runs so a re-prepare RENEWS the lease instead of hitting the
// conflict branch (same-requestId renewal, verified contract).
const REQUEST_ID = `host-idle-${SANDBOX_NAME}`;

export async function GET(req: NextRequest) {
  // Vercel cron requests carry the CRON_SECRET when one is configured.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'OPENCLAW_GATEWAY_TOKEN not set' }, { status: 500 });
  }

  try {
    return NextResponse.json(await runCheck(token));
  } catch (err) {
    // A transient gateway shape or API blip must not read as a platform
    // fault; log it and report, the next tick retries.
    console.error('idle-check failed:', err);
    return NextResponse.json({
      action: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runCheck(token: string) {
  const now = Date.now();

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({
      name: SANDBOX_NAME,
      resume: false,
      // The SDK auto-resumes a stopped sandbox on the first command; if that
      // happens mid-check the gateway must come back too, or we'd leave a
      // gatewayless VM running.
      onResume: async (sbx) => startGateway(sbx, token),
    });
  } catch (err) {
    // Only a genuine not-found is a quiet no-op; anything else (auth,
    // network, 5xx) must surface, or a broken credential reads as healthy.
    if (err instanceof APIError && err.response?.status === 404) {
      return { action: 'none', reason: 'no sandbox' };
    }
    throw err;
  }
  if (sandbox.status !== 'running') {
    return { action: 'none', reason: `sandbox ${sandbox.status}` };
  }

  const call = createSandboxGatewayCaller(sandbox, token);
  const stop = async () => {
    await sandbox.stop();
  };

  // Ceiling path: the platform deadline is near. Webhook traffic normally
  // tops the deadline up; when extension stopped working (hard 24h plan
  // maximum), go graceful before the platform kill, forcing at T-60s. The
  // 5-minute cron granularity can't honor the contract's 20s retry cadence,
  // so the loop runs INSIDE this request until stop or force-stop.
  const expiresAt = sandbox.expiresAt?.getTime();
  if (expiresAt !== undefined && expiresAt - now < CEILING_WINDOW_MS) {
    const forceStopAtMs = expiresAt - CEILING_FORCE_STOP_MARGIN_MS;
    while (true) {
      const decision = await attemptSuspend(
        { call, stop, requestId: REQUEST_ID },
        { ceiling: { forceStopAtMs } },
      );
      if (decision.action !== 'retry') {
        return { action: decision.action, path: 'ceiling', decision };
      }
      const waitMs = Math.min(
        Math.max(decision.nextRetryAtMs - Date.now(), 1_000),
        Math.max(forceStopAtMs - Date.now(), 0),
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // Idle path.
  const lastActivityAt = await defaultActivityStore.latest();
  if (lastActivityAt === undefined || !isIdle({ lastActivityAt }, now, IDLE_THRESHOLD_MS)) {
    return { action: 'none', reason: 'not idle', lastActivityAt };
  }

  const decision = await attemptSuspend({ call, stop, requestId: REQUEST_ID });

  if (decision.action === 'rearm') {
    // Busy = the gateway is working. Persist the re-arm so the next ticks
    // skip cheaply instead of re-preparing every 5 minutes for a long run.
    await defaultActivityStore.set(
      'gateway-busy-rearm',
      now - IDLE_THRESHOLD_MS + IDLE_REARM_MS,
    );
  }
  return { action: decision.action, path: 'idle', decision };
}
