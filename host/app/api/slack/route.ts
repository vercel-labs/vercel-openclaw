import { getToken } from '@vercel/connect';
import { createConnectWebhookVerifier } from '@vercel/connect/chat';
import { after, NextRequest, NextResponse } from 'next/server';
import { decideAccess } from '@/lib/access';
import { defaultActivityStore } from '@/lib/activity-store';
import { runAgentTurn, slackSessionKey } from '@/lib/agent';
import { claimEvent } from '@/lib/dedupe';
import {
  createExecutionBudget,
  withExecutionBudget,
  type ExecutionBudget,
} from '@/lib/execution-budget';
import {
  parseSlackEvent,
  postSlackReaction,
  postSlackReply,
  removeSlackReaction,
  type SlackReplyTarget,
  type SlackThreadMessage,
} from '@/lib/slack';
import { ensureAwake, topUpSessionTimeout } from '@/lib/wake';

/**
 * POST /api/slack
 *
 * The Connect front door. Vercel Connect owns the Slack app, verifies Slack's
 * signature at its own intake, and forwards the event here. This app owns the
 * channel: it decides whether to act, hands OpenClaw only the message text, and
 * posts the reply itself with a token minted per call. No Slack credential ever
 * enters the sandbox.
 *
 * Order matters. Verification comes first so unauthenticated traffic cannot wake
 * compute or reset the idle clock. Access and de-duplication come before the
 * ack, because both decide whether a turn happens at all.
 *
 * Everything that is not "this turn should run" answers 200. A non-2xx would
 * make Connect retry (it retries 5xx up to three times), and there is nothing to
 * retry about a message we deliberately ignored.
 *
 * Register the destination with:
 *   vercel connect create slack --name openclaw --triggers --trigger-path /api/slack
 *   vercel connect attach slack/openclaw --environment production --triggers --trigger-path /api/slack
 */

export const maxDuration = 300;

const SANDBOX_NAME = process.env.OPENCLAW_SANDBOX_NAME ?? 'openclaw';

/**
 * Verifies the Vercel OIDC token Connect attaches as a Bearer credential on the
 * forwarded request, replacing Slack's own signature check.
 *
 * Trust boundary worth being explicit about, from the helper's own contract: the
 * issuer is pinned to https://oidc.vercel.com and the token must match this
 * project and environment, but it is NOT pinned to a specific connector or
 * deployment. What this proves is "a Vercel OIDC token for this project and
 * environment", not "this came from our Slack connector".
 */
const verifyConnectWebhook = createConnectWebhookVerifier();

/** Connector UID, e.g. `slack/openclaw`. */
function slackConnector(): string {
  const connector = process.env.SLACK_CONNECTOR;
  if (!connector) throw new Error('SLACK_CONNECTOR not set (e.g. slack/openclaw)');
  return connector;
}

export async function POST(req: NextRequest) {
  const budget = createExecutionBudget();
  const rawBody = await req.text();

  try {
    await verifyConnectWebhook(req, rawBody);
  } catch (err) {
    console.error('Connect webhook verification failed:', err);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseSlackEvent(body);
  if (!parsed.handle) {
    console.log(`slack event ignored: ${parsed.reason}`);
    return NextResponse.json({ ok: true, ignored: parsed.reason });
  }
  const message = parsed.message;

  // OpenClaw's own DM allowlists and mention gates do not run when the host owns
  // the channel, so this is the only thing deciding who may drive the agent.
  const access = decideAccess(message.userId);
  if (!access.allowed) {
    console.warn(`slack event denied (${access.reason}) for user ${message.userId ?? 'unknown'}`);
    return NextResponse.json({ ok: true, ignored: access.reason });
  }

  // Claim before acking: a retry that arrives while the first turn is still
  // waking must not start a second one.
  if (!(await claimEvent(message.eventId))) {
    console.log(`slack event ${message.eventId} already claimed; skipping duplicate`);
    return NextResponse.json({ ok: true, ignored: 'duplicate' });
  }

  // Ack now, work after. Slack expects a fast ack and a cold wake takes ~10s,
  // with the turn itself taking longer still.
  // Reuse the exact bearer token the verifier just authenticated. Do not trust
  // a second, independently supplied OIDC-looking header for model brokering.
  const oidcToken = req.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!oidcToken) {
    console.error('Connect verifier accepted a request without a bearer token');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  after(() => handleTurn(message, { oidcToken, budget }));

  return NextResponse.json({ ok: true });
}

/**
 * Runs the turn and posts the reply, after the response has been sent.
 *
 * Bounded by the function's own budget (maxDuration), so a turn that outlives it
 * is cut off. `runAgentTurn` pins OpenClaw's timeout below that so the gateway
 * is not left working on a reply nobody will collect.
 */
interface SlackTurnContext {
  oidcToken: string;
  budget: ExecutionBudget;
}

async function handleTurn(
  message: SlackThreadMessage,
  context: SlackTurnContext,
): Promise<void> {
  const sessionKey = slackSessionKey(message.channelId, message.userId);
  const startedAt = Date.now();
  let slackToken: string | undefined;
  let reactionAdded = false;

  try {
    slackToken = await mintSlackToken(context.budget, context.oidcToken);
    try {
      await postSlackReaction({
        token: slackToken,
        channelId: message.channelId,
        messageTs: message.messageTs,
        name: 'eyes',
        budget: context.budget,
      });
      reactionAdded = true;
    } catch (err) {
      console.warn(`Slack progress reaction failed for ${sessionKey}:`, err);
    }

    // The idle clock is bookkeeping. Keep it after the visible acknowledgement
    // so a degraded Redis store cannot make an accepted mention look lost.
    try {
      await withExecutionBudget(
        context.budget,
        'activity store write',
        async () => defaultActivityStore.set('slack', Date.now()),
        { capMs: 5_000 },
      );
    } catch (err) {
      console.error('activity store write failed; idle clock may be stale:', err);
    }

    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!gatewayToken) {
      throw new Error('OPENCLAW_GATEWAY_TOKEN not set; cannot run a turn');
    }

    const wakeStartedAt = Date.now();
    const awake = await ensureAwake(SANDBOX_NAME, context);
    await topUpSessionTimeout(awake.sandbox, context.budget);
    console.info(`slack turn phase wake session=${sessionKey} durationMs=${Date.now() - wakeStartedAt}`);

    const agentStartedAt = Date.now();
    const turn = await runAgentTurn({
      sandbox: awake.sandbox,
      message: message.text,
      sessionKey,
      gatewayToken,
      budget: context.budget,
    });
    console.info(`slack turn phase agent session=${sessionKey} durationMs=${Date.now() - agentStartedAt}`);

    const reply = turn.reply.trim();
    if (!reply) {
      throw new Error(`turn for ${sessionKey} produced no reply text`);
    }

    await postReply(message, reply, context.budget, slackToken);
    console.info(`slack turn complete session=${sessionKey} durationMs=${Date.now() - startedAt}`);
  } catch (err) {
    console.error(`turn failed for ${sessionKey}:`, err);
    // Say something rather than leaving the mention unanswered. Deliberately
    // generic: error text can carry paths, tokens, and internals.
    try {
      slackToken ??= await mintSlackToken(context.budget, context.oidcToken);
      await postReply(
        message,
        'Something went wrong handling that. Check the logs.',
        context.budget,
        slackToken,
      );
    } catch (postErr) {
      console.error('failed to post the failure notice:', postErr);
    }
  } finally {
    if (slackToken && reactionAdded) {
      await removeSlackReaction({
        token: slackToken,
        channelId: message.channelId,
        messageTs: message.messageTs,
        name: 'eyes',
        budget: context.budget,
      }).catch((err) => console.warn(`Slack progress reaction cleanup failed for ${sessionKey}:`, err));
    }
  }
}

/** Mints one short-lived bot token for acknowledgement and reply operations. */
async function mintSlackToken(
  budget: ExecutionBudget,
  vercelToken: string,
): Promise<string> {
  return withExecutionBudget(
    budget,
    'Connect token mint',
    async () =>
      getToken(
        slackConnector(),
        {
          subject: { type: 'app' },
          scopes: ['chat:write', 'reactions:write'],
        },
        { vercelToken },
    ),
    { capMs: 10_000, reserveReply: false },
  );
}

/** Posts a final or controlled-failure reply in the originating thread. */
async function postReply(
  message: SlackReplyTarget,
  text: string,
  budget: ExecutionBudget,
  token: string,
): Promise<void> {
  await postSlackReply({
    token,
    channelId: message.channelId,
    threadTs: message.threadTs,
    text,
    budget,
  });
}
