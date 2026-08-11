import { NextRequest, NextResponse } from 'next/server';
import { InMemoryActivityStore } from '@/lib/activity-store';
import { ensureAwake, forwardPayload } from '@/lib/wake';

/**
 * POST /api/webhook/[channel]
 *
 * Webhooks terminate at the host, never at the sandbox (a sleeping VM is
 * unreachable). This route: stamps lastActivityAt, wakes the sandbox if
 * needed, and forwards the ORIGINAL body into the gateway's native channel
 * handler. See docs/suspension-spec.md, "Wake paths".
 */

const activityStore = new InMemoryActivityStore();

// Gateway-native handler paths per channel. Slack's is verified from the
// previous deployment's audit; add others as their paths are confirmed
// (open contract question with the OpenClaw team).
const CHANNEL_PATHS: Record<string, string> = {
  slack: '/slack/events',
};

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel } = await params;
  const path = CHANNEL_PATHS[channel];
  if (!path) {
    return NextResponse.json(
      { error: `unsupported channel: ${channel}` },
      { status: 404 },
    );
  }

  // Read the raw body: channel handlers verify signatures over the exact
  // bytes the sender posted, so it must never be re-serialized.
  const rawBody = await req.text();
  const receivedAt = Date.now();
  await activityStore.set(channel, receivedAt);

  try {
    // GATEWAY_URL overrides the wake path for local development against a
    // directly reachable gateway. Production always goes through ensureAwake.
    const baseUrl =
      process.env.GATEWAY_URL ?? (await ensureAwake(SANDBOX_NAME)).baseUrl;

    const upstream = await forwardPayload(baseUrl, path, {
      rawBody,
      contentType: req.headers.get('content-type'),
      channel,
      receivedAt,
    });

    if (!upstream.ok) {
      console.error(`gateway responded ${upstream.status} for ${channel}`);
      return NextResponse.json({ error: 'gateway_error' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('webhook forward failed:', err);
    return NextResponse.json({ error: 'forward_failed' }, { status: 502 });
  }
}
