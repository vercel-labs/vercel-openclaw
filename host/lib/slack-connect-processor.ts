import { defaultActivityStore } from './activity-store';
import type { BackgroundConnectWebhook } from './connect-webhook-handler';
import { ensureAwake, forwardPayload, topUpSessionTimeout } from './wake';

const SLACK_GATEWAY_PATH = '/slack/events';

function hostBridgeToken(): string {
  const token = process.env.OPENCLAW_SLACK_HOST_BRIDGE_TOKEN;
  if (!token) throw new Error('OPENCLAW_SLACK_HOST_BRIDGE_TOKEN not set');
  return token;
}

export async function processVerifiedSlackWebhook({
  rawBody,
  headers,
  receivedAt,
  oidcToken,
}: BackgroundConnectWebhook): Promise<void> {
  try {
    await defaultActivityStore.set('slack', receivedAt);
  } catch (err) {
    console.error('activity store write failed; idle clock may be stale:', err);
  }

  let baseUrl = process.env.GATEWAY_URL;
  if (!baseUrl) {
    const sandboxName = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';
    // The verified bearer remains host-side and is injected only by the
    // sandbox firewall on egress to AI Gateway.
    const awake = await ensureAwake(sandboxName, {
      oidcToken,
      exposeGatewayPort: true,
    });
    baseUrl = awake.baseUrl;
    await topUpSessionTimeout(awake.sandbox);
  }

  // Replace Connect's project OIDC with the narrow host-to-sandbox assertion.
  // The raw Slack envelope remains byte-for-byte unchanged.
  const bridgeHeaders = new Headers(headers);
  bridgeHeaders.set('authorization', `Bearer ${hostBridgeToken()}`);
  const upstream = await forwardPayload(baseUrl, SLACK_GATEWAY_PATH, {
    rawBody,
    headers: bridgeHeaders,
    forwardHeaders: [
      'authorization',
      'content-type',
      'x-slack-retry-num',
      'x-slack-retry-reason',
    ],
    channel: 'slack',
    receivedAt,
  });
  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    console.error(`gateway responded ${upstream.status} for Slack${detail ? `: ${detail}` : ''}`);
  }
}
