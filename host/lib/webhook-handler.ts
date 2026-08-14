import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const SLACK_TIMESTAMP_TOLERANCE_S = 300;

export interface BackgroundWebhook {
  channel: string;
  rawBody: ArrayBuffer;
  headers: Headers;
  receivedAt: number;
  /** Request-scoped Vercel OIDC token; never forwarded as a webhook header. */
  vercelOidcToken?: string;
}

type ScheduledTask = () => void | Promise<void>;

interface WebhookHandlerDependencies {
  schedule: (task: ScheduledTask) => void;
  processVerifiedWebhook: (message: BackgroundWebhook) => Promise<void>;
  getSlackSigningSecret: () => string | undefined;
  now?: () => number;
}

type RouteContext = { params: Promise<{ channel: string }> };
type SignatureVerdict = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Builds the request-facing half of the webhook route. It does only the work
 * Slack requires before its three-second deadline: read the exact bytes,
 * verify their signature, enqueue the slow wake/forward work, and acknowledge.
 */
export function createWebhookHandler(deps: WebhookHandlerDependencies) {
  const now = deps.now ?? Date.now;

  return async function handleWebhook(req: NextRequest, { params }: RouteContext) {
    const { channel } = await params;
    if (channel !== 'slack') {
      return NextResponse.json(
        { error: `unsupported channel: ${channel}` },
        { status: 404 },
      );
    }

    const rawBody = await req.arrayBuffer();
    const challenge = parseSlackChallenge(rawBody);
    if (challenge !== undefined) {
      return NextResponse.json({ challenge });
    }

    const verdict = verifySlackSignature(
      req.headers,
      Buffer.from(rawBody),
      deps.getSlackSigningSecret(),
      now(),
    );
    if (!verdict.ok) {
      return NextResponse.json(
        { error: verdict.reason },
        { status: verdict.status },
      );
    }

    const message: BackgroundWebhook = {
      channel,
      rawBody,
      headers: new Headers(req.headers),
      receivedAt: now(),
      vercelOidcToken: req.headers.get('x-vercel-oidc-token') ?? undefined,
    };
    deps.schedule(async () => {
      try {
        await deps.processVerifiedWebhook(message);
      } catch (err) {
        console.error('webhook background forward failed:', err);
      }
    });

    return NextResponse.json({ ok: true });
  };
}

function parseSlackChallenge(rawBody: ArrayBuffer): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    if (parsed?.type === 'url_verification' && typeof parsed.challenge === 'string') {
      return parsed.challenge;
    }
  } catch {
    // Normal Slack webhook bodies may be form-encoded rather than JSON.
  }
  return undefined;
}

function verifySlackSignature(
  headers: Headers,
  rawBody: Buffer,
  secret: string | undefined,
  nowMs: number,
): SignatureVerdict {
  if (!secret) {
    return {
      ok: false,
      status: 503,
      reason: 'SLACK_SIGNING_SECRET not configured',
    };
  }
  const timestamp = headers.get('x-slack-request-timestamp');
  const signature = headers.get('x-slack-signature');
  if (!timestamp || !signature) {
    return { ok: false, status: 401, reason: 'missing signature headers' };
  }
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_TIMESTAMP_TOLERANCE_S) {
    return { ok: false, status: 401, reason: 'stale timestamp' };
  }
  const expected = `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest('hex')}`;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }
  return { ok: true };
}
