import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { defaultActivityStore } from '@/lib/activity-store';
import { ensureAwake, forwardPayload, SESSION_TIMEOUT_MS } from '@/lib/wake';

/**
 * POST /api/webhook/[channel]
 *
 * Webhooks terminate at the host, never at the sandbox (a sleeping VM is
 * unreachable). Order matters for cost and abuse resistance: the sender's
 * signature is verified FIRST, before any state is touched or any compute is
 * woken — an unauthenticated caller must not be able to boot VMs or reset
 * the idle clock. Then: stamp activity, wake, top the session timeout back
 * up, forward the ORIGINAL bytes to the gateway's native handler, and proxy
 * the gateway's response back to the sender (slash commands, interactive
 * components, and Slack's setup handshake all read the HTTP response).
 * See docs/suspension-spec.md, "Wake paths".
 *
 * v1 LIMITATION: the response blocks on the wake, which can take minutes on
 * a cold resume, while e.g. Slack expects a 3-second ack and retries on
 * timeout. The PoC answer (ack-then-forward via `after()`, and how the
 * gateway dedupes redelivery) is part of the open contract questions.
 */

export const maxDuration = 300;

const activityStore = defaultActivityStore;

// Gateway-native handler paths per channel. Slack's is verified from the
// earlier vercel-openclaw deployment; add others as their paths are
// confirmed (open contract question with the OpenClaw team).
const CHANNEL_PATHS: Record<string, string> = {
  slack: '/slack/events',
};

// Allowlist of inbound headers forwarded to the gateway, per channel. The
// gateway URL is publicly routable, so unknown-but-sensitive headers
// (cookies, platform headers) must not ride along.
const CHANNEL_FORWARD_HEADERS: Record<string, string[]> = {
  slack: [
    'content-type',
    'x-slack-signature',
    'x-slack-request-timestamp',
    'x-slack-retry-num',
    'x-slack-retry-reason',
  ],
};

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';
const SLACK_TIMESTAMP_TOLERANCE_S = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel } = await params;
  // Object.hasOwn: a plain-object lookup would resolve prototype keys
  // ("constructor", "toString") and let them through the guard.
  if (!Object.hasOwn(CHANNEL_PATHS, channel)) {
    return NextResponse.json(
      { error: `unsupported channel: ${channel}` },
      { status: 404 },
    );
  }
  const path = CHANNEL_PATHS[channel];

  // Raw bytes, not text: signatures verify over the exact bytes the sender
  // posted, and a UTF-8 decode/re-encode round trip corrupts any non-UTF-8
  // payload. Buffer.from(arrayBuffer) is a zero-copy view for the HMAC.
  const rawBody = await req.arrayBuffer();

  // Slack's one-time URL-verification handshake must be answered with the
  // challenge value or Event Subscriptions can never be saved. Answered
  // before signature verification (whether Slack signs this handshake is
  // undocumented); it echoes a caller-supplied string and touches no state.
  if (channel === 'slack') {
    const challenge = parseSlackChallenge(rawBody);
    if (challenge !== undefined) {
      return NextResponse.json({ challenge });
    }
  }

  const verdict = verifyChannelSignature(channel, req.headers, Buffer.from(rawBody));
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: verdict.status });
  }

  const receivedAt = Date.now();
  // Store failure must not drop the message: a stale idle clock is far less
  // bad than a lost user message plus a sender retry storm.
  try {
    await activityStore.set(channel, receivedAt);
  } catch (err) {
    console.error('activity store write failed; idle clock may be stale:', err);
  }

  try {
    // GATEWAY_URL overrides the wake path for local development against a
    // directly reachable gateway. Production always goes through ensureAwake.
    let baseUrl = process.env.GATEWAY_URL;
    if (!baseUrl) {
      const awake = await ensureAwake(SANDBOX_NAME);
      baseUrl = awake.baseUrl;
      // extendTimeout ADDS duration; it does not reset the deadline. Top the
      // session back up to the full backstop window by the shortfall only,
      // so expiresAt never outruns wall clock by more than 75 minutes.
      try {
        const expiresAt = awake.sandbox.expiresAt?.getTime();
        if (expiresAt !== undefined) {
          const shortfall = SESSION_TIMEOUT_MS - (expiresAt - Date.now());
          if (shortfall > 0) await awake.sandbox.extendTimeout(shortfall);
        }
      } catch (err) {
        // At the plan's hard 24h maximum this starts failing: that is the
        // signal the cron's ceiling path takes over. Loud on purpose.
        console.error('extendTimeout failed (hard ceiling reached?):', err);
      }
    }

    const upstream = await forwardPayload(baseUrl, path, {
      rawBody,
      headers: req.headers,
      forwardHeaders: CHANNEL_FORWARD_HEADERS[channel] ?? ['content-type'],
      channel,
      receivedAt,
    });

    if (!upstream.ok) {
      console.error(`gateway responded ${upstream.status} for ${channel}`);
    }
    // Proxy the gateway's response through: Slack reads slash-command and
    // interactivity replies (and error semantics) from this HTTP response.
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (err) {
    console.error('webhook forward failed:', err);
    return NextResponse.json({ error: 'forward_failed' }, { status: 502 });
  }
}

/** Returns the challenge string for Slack's url_verification event, else undefined. */
function parseSlackChallenge(rawBody: ArrayBuffer): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    if (parsed?.type === 'url_verification' && typeof parsed.challenge === 'string') {
      return parsed.challenge;
    }
  } catch {
    // not JSON: a normal signed payload, fall through to verification
  }
  return undefined;
}

type SignatureVerdict = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Host-side sender verification, fail-closed. The gateway's channel handler
 * verifies again over the forwarded bytes; this first check exists so
 * unauthenticated traffic can't wake compute.
 */
function verifyChannelSignature(
  channel: string,
  headers: Headers,
  rawBody: Buffer,
): SignatureVerdict {
  switch (channel) {
    case 'slack': {
      const secret = process.env.SLACK_SIGNING_SECRET;
      if (!secret) {
        return { ok: false, status: 503, reason: 'SLACK_SIGNING_SECRET not configured' };
      }
      const timestamp = headers.get('x-slack-request-timestamp');
      const signature = headers.get('x-slack-signature');
      if (!timestamp || !signature) {
        return { ok: false, status: 401, reason: 'missing signature headers' };
      }
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > SLACK_TIMESTAMP_TOLERANCE_S) {
        return { ok: false, status: 401, reason: 'stale timestamp' };
      }
      const expected = `v0=${createHmac('sha256', secret)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest('hex')}`;
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, status: 401, reason: 'signature mismatch' };
      }
      return { ok: true };
    }
    default:
      // Unreachable while CHANNEL_PATHS only lists slack; new channels must
      // add a verifier here — fail closed rather than forward unverified.
      return { ok: false, status: 501, reason: `no verifier for channel: ${channel}` };
  }
}
