import { after } from 'next/server';
import { defaultActivityStore } from '@/lib/activity-store';
import {
  createWebhookHandler,
  type BackgroundWebhook,
} from '@/lib/webhook-handler';
import { addSlackAckReaction } from '@/lib/slack-ack';
import { ensureAwake, forwardPayload, SESSION_TIMEOUT_MS } from '@/lib/wake';

/**
 * POST /api/webhook/[channel]
 *
 * The request-facing handler verifies Slack over the original bytes and
 * acknowledges immediately. `after()` keeps this function alive for the
 * slower wake and forward path without making Slack wait (and retry) while a
 * suspended sandbox starts.
 */

export const maxDuration = 300;

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';
const SLACK_GATEWAY_PATH = '/slack/events';
const SLACK_FORWARD_HEADERS = [
  'content-type',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'x-slack-retry-num',
  'x-slack-retry-reason',
];

const processVerifiedWebhook = async ({
  channel,
  rawBody,
  headers,
  receivedAt,
  vercelOidcToken,
}: BackgroundWebhook): Promise<void> => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (botToken) {
    const ack = await addSlackAckReaction(rawBody, botToken);
    if (!ack.ok && !('skipped' in ack)) {
      console.warn(`Slack acknowledgement reaction failed: ${ack.error}`);
    }
  }

  // Store failure must not drop the message: a stale idle clock is less
  // harmful than a lost Slack event.
  try {
    await defaultActivityStore.set(channel, receivedAt);
  } catch (err) {
    console.error('activity store write failed; idle clock may be stale:', err);
  }

  // GATEWAY_URL remains a local-development escape hatch. Production wakes
  // or creates the named persistent sandbox.
  let baseUrl = process.env.GATEWAY_URL;
  if (!baseUrl) {
    const awake = await ensureAwake(SANDBOX_NAME, {
      aiGatewayCredential: vercelOidcToken,
    });
    baseUrl = awake.baseUrl;

    // extendTimeout adds duration rather than resetting the deadline. Add
    // only the shortfall so the session stays capped at 75 minutes from now.
    try {
      const expiresAt = awake.sandbox.expiresAt?.getTime();
      if (expiresAt !== undefined) {
        const shortfall = SESSION_TIMEOUT_MS - (expiresAt - Date.now());
        if (shortfall > 0) await awake.sandbox.extendTimeout(shortfall);
      }
    } catch (err) {
      console.error('extendTimeout failed (hard ceiling reached?):', err);
    }
  }

  const upstream = await forwardPayload(baseUrl, SLACK_GATEWAY_PATH, {
    rawBody,
    headers,
    forwardHeaders: SLACK_FORWARD_HEADERS,
    channel,
    receivedAt,
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 500);
    console.error(
      `gateway responded ${upstream.status} for ${channel}${detail ? `: ${detail}` : ''}`,
    );
  }
};

export const POST = createWebhookHandler({
  schedule: (task) => after(task),
  processVerifiedWebhook,
  getSlackSigningSecret: () => process.env.SLACK_SIGNING_SECRET,
});
