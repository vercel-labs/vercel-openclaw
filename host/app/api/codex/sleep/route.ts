import { getVercelOidcToken } from '@vercel/oidc';
import { NextRequest, NextResponse } from 'next/server';
import { claimCodexSleep } from '@/lib/codex-admission';
import { stopCodexSession } from '@/lib/codex-lifecycle';
import { authorizeSleep } from '@/lib/codex-sleep-auth';
import { safeCodexError } from '@/lib/codex-diagnostics';

export const maxDuration = 240;

export async function POST(req: NextRequest) {
  if (process.env.OPENCLAW_ENGINE !== 'codex') return NextResponse.json({}, { status: 404 });
  const name = process.env.OPENCLAW_CODEX_SANDBOX_NAME;
  const digest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST;
  if (!name || !digest || !process.env.OPENCLAW_GATEWAY_TOKEN) return NextResponse.json({}, { status: 503 });
  let platformSessionId: string;
  try {
    const raw = await req.text();
    if (raw.length > 2048) throw new Error('Invalid body');
    const body = JSON.parse(raw);
    platformSessionId = body.platformSessionId;
    if (typeof platformSessionId !== 'string' || !/^sbx_[A-Za-z0-9]+$/.test(platformSessionId) || body.runtimeDigest !== digest || !authorizeSleep(req.headers.get('authorization'), name, platformSessionId, digest)) throw new Error('Unauthorized');
  } catch { return NextResponse.json({}, { status: 401 }); }
  const admission = await claimCodexSleep(name);
  if (!admission.accepted) return NextResponse.json({ action: 'busy' });
  try {
    const result = await stopCodexSession({ name, platformSessionId, oidcToken: await getVercelOidcToken() });
    console.info('codex sleep receipt', JSON.stringify(result));
    return NextResponse.json(result);
  } catch (error) {
    console.error('codex sleep failed', JSON.stringify(safeCodexError(error)));
    return NextResponse.json({ error: 'Sleep not confirmed' }, { status: 500 });
  } finally { await admission.release(); }
}
