import { NextRequest, NextResponse } from 'next/server';
import { Sandbox } from '@vercel/sandbox';
import { defaultActivityStore } from '@/lib/activity-store';
import { isIdle } from '@/lib/activity';
import { attemptSuspend, createSandboxGatewayCaller } from '@/lib/suspend';

/**
 * The idle-path scheduler per docs/suspension-spec.md: runs every 5 minutes
 * (vercel.json crons), suspends the sandbox after 60 minutes without
 * host-visible activity. The timer only initiates; gateway.suspend.prepare
 * is the correctness gate that protects running work.
 */

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';

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

  const lastActivityAt = await defaultActivityStore.latest();
  const now = Date.now();
  if (lastActivityAt === undefined || !isIdle({ lastActivityAt }, now)) {
    return NextResponse.json({ action: 'none', reason: 'not idle', lastActivityAt });
  }

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ name: SANDBOX_NAME, resume: false });
  } catch {
    return NextResponse.json({ action: 'none', reason: 'no sandbox' });
  }
  if (sandbox.status !== 'running') {
    return NextResponse.json({ action: 'none', reason: `sandbox ${sandbox.status}` });
  }

  const decision = await attemptSuspend({
    call: createSandboxGatewayCaller(sandbox, token),
    stop: async () => {
      await sandbox.stop();
    },
    requestId: `idle-${now}`,
  });
  return NextResponse.json({ action: decision.action, decision });
}
