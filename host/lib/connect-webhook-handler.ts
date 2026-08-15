import { NextRequest, NextResponse } from 'next/server';

export interface BackgroundConnectWebhook {
  rawBody: ArrayBuffer;
  headers: Headers;
  receivedAt: number;
  /** Exact Connect bearer already accepted by the verifier. */
  vercelOidcToken: string;
}

type ScheduledTask = () => void | Promise<void>;

interface ConnectWebhookHandlerDependencies {
  verify: (request: NextRequest, rawBody: string) => Promise<unknown>;
  schedule: (task: ScheduledTask) => void;
  processVerifiedWebhook: (message: BackgroundConnectWebhook) => Promise<void>;
  now?: () => number;
}

/**
 * Verifies Connect before acknowledging, then preserves the exact request body
 * for the native OpenClaw Slack handler. Connect, not this host, verified Slack.
 */
export function createConnectWebhookHandler(deps: ConnectWebhookHandlerDependencies) {
  const now = deps.now ?? Date.now;

  return async function handleConnectWebhook(req: NextRequest) {
    const rawBody = await req.arrayBuffer();
    const rawText = Buffer.from(rawBody).toString('utf8');
    try {
      await deps.verify(req, rawText);
    } catch {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const vercelOidcToken = req.headers
      .get('authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    if (!vercelOidcToken) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const message: BackgroundConnectWebhook = {
      rawBody,
      headers: new Headers(req.headers),
      receivedAt: now(),
      vercelOidcToken,
    };
    deps.schedule(async () => {
      try {
        await deps.processVerifiedWebhook(message);
      } catch (err) {
        console.error('Connect Slack background forward failed:', err);
      }
    });

    return NextResponse.json({ ok: true });
  };
}
