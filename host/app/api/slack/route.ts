import { getToken } from '@vercel/connect';
import { createConnectWebhookVerifier } from '@vercel/connect/chat';
import { after, NextRequest, NextResponse } from 'next/server';
import { decideAccess } from '@/lib/access';
import { defaultActivityStore } from '@/lib/activity-store';
import { runAgentTurn, slackSessionKey } from '@/lib/agent';
import { claimEvent } from '@/lib/dedupe';
import { admitCodexEvent } from '@/lib/codex-admission';
import { runCodexLifecycle } from '@/lib/codex-lifecycle';
import { CodexLifecycleError, safeCodexError } from '@/lib/codex-diagnostics';
import { nativeSlackAllowed } from '@/lib/codex-native-slack';
import { setSlackSessionStatus } from '@/lib/slack-status';
import {
  createExecutionBudget,
  withExecutionBudget,
  type ExecutionBudget,
} from '@/lib/execution-budget';
import {
  THINKING_TEXT,
  parseSlackEvent,
  postSlackReaction,
  postSlackReply,
  removeSlackReaction,
  updateSlackMessage,
  type SlackReplyTarget,
  type SlackThreadMessage,
  type InboundSlackMessage,
} from '@/lib/slack';
import { ensureAwake, topUpSessionTimeout } from '@/lib/wake';

/**
 * POST /api/slack
 *
 * The Connect front door. Vercel Connect owns the Slack app, verifies Slack's
 * signature at its own intake, and forwards the event here. This app owns the
 * admission policy. The native Codex path forwards the full event to OpenClaw;
 * the legacy path forwards text and posts the reply here. Slack credentials
 * stay outside the guest and are injected on egress for native delivery.
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

  // Keep the host allowlist in both modes; native policy adds its own gate below.
  const access = decideAccess(message.userId);
  if (!access.allowed) {
    console.warn(`slack event denied (${access.reason}) for user ${message.userId ?? 'unknown'}`);
    return NextResponse.json({ ok: true, ignored: access.reason });
  }

  if (process.env.OPENCLAW_ENGINE === 'codex') {
    if (process.env.OPENCLAW_CODEX_NATIVE_SLACK === '1') {
      try {
        if (Buffer.byteLength(rawBody) > 1024 * 1024 || !nativeSlackAllowed(body)) {
          return NextResponse.json({ ok: true, ignored: 'native_slack_not_allowed' });
        }
      } catch {
        return NextResponse.json({ error: 'native_slack_not_configured' }, { status: 503 });
      }
    }
    const oidcToken = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!oidcToken) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const name = process.env.OPENCLAW_CODEX_SANDBOX_NAME;
    if (!name) return NextResponse.json({ error: 'codex_not_configured' }, { status: 503 });
    try {
      const admission = await admitCodexEvent(name, message.eventId);
      if (admission.status === 'duplicate') return NextResponse.json({ ok: true, ignored: 'duplicate' });
      if (admission.status === 'busy') return NextResponse.json({ error: 'busy' }, { status: 503 });
      after(async () => {
        try { await handleCodexTurn(name, message, { oidcToken, budget, rawBody }); }
        finally { await admission.release(); }
      });
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ error: 'admission_unavailable' }, { status: 503 });
    }
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
  rawBody?: string;
}

async function handleCodexTurn(name: string, message: InboundSlackMessage, context: SlackTurnContext) {
  const nativeSlack = process.env.OPENCLAW_CODEX_NATIVE_SLACK === '1';
  let placeholderTs: string | undefined;
  let delivered = false;
  let slackToken: string | undefined;
  let eyesAdded = false;
  let acknowledgement: Promise<unknown> | undefined;
  const reaction = { channelId: message.channelId, messageTs: message.messageTs, name: 'eyes', budget: context.budget };
  const status = async (value: 'processing' | 'active') => {
    const at = Date.now();
    try {
      await setSlackSessionStatus({ ...message, token: slackToken!, status: value, budget: context.budget });
      console.info('codex slack status', JSON.stringify({ eventId: message.eventId, status: value, startedAt: at, completedAt: Date.now() }));
    } catch { console.warn('Codex Slack session status could not be updated'); }
  };
  try {
    slackToken = await mintSlackToken(context.budget, context.oidcToken);
    acknowledgement = Promise.all([
      postSlackReaction({ ...reaction, token: slackToken }).then(() => { eyesAdded = true; }).catch(() => { console.warn('Codex eyes acknowledgement could not be added'); }),
      ...(nativeSlack ? [status('processing')] : []),
    ]);
    if (!nativeSlack) await acknowledgement;
    if (!nativeSlack) placeholderTs = (await postReply(message, THINKING_TEXT, context.budget, slackToken)).ts;
    const receipt = await runCodexLifecycle({ name, sessionKey: slackSessionKey(message.channelId), eventId: message.eventId!, message: message.text, ...context,
      onNativeDelivered: () => { delivered = true; },
      ...(nativeSlack ? { nativeSlack: { rawBody: context.rawBody!, token: slackToken } } : {}),
      publish: async reply => {
        slackToken = await mintSlackToken(context.budget, context.oidcToken);
        await settle(message, placeholderTs, reply, context.budget, slackToken);
        delivered = true;
      },
    });
    if (receipt.nativeSlackDelivered) delivered = true;
    console.info(`codex lifecycle complete session=${receipt.sessionId} worker=${receipt.workerName} vm1=${receipt.gatewayStopped ? 'stopped' : 'warm'}`);
    console.info('codex lifecycle receipt', JSON.stringify({ eventId: message.eventId, sessionId: receipt.sessionId, runId: receipt.runId, workerName: receipt.workerName, nativeSlackDelivered: receipt.nativeSlackDelivered === true, gatewayStopped: receipt.gatewayStopped, vm1Stopped: receipt.gatewayStopped, platformSessionId: receipt.platformSessionId, gatewayPid: receipt.gatewayPid, workerReused: receipt.workerReused, idleTimeoutMs: receipt.idleTimeoutMs, vm1SnapshotId: receipt.vm1SnapshotId, suspension: receipt.suspension, phases: receipt.phases }));
  } catch (error) {
    console.error('codex host failure', JSON.stringify({ eventId: message.eventId, phase: error instanceof CodexLifecycleError ? error.phase : 'slack-host', delivered, error: safeCodexError(error instanceof CodexLifecycleError ? error.cause : error) }));
    if (!delivered) {
      try {
        slackToken = await mintSlackToken(context.budget, context.oidcToken);
        await settle(message, placeholderTs, 'Something went wrong handling that. Check the logs.', context.budget, slackToken);
      } catch { console.error('Codex failure notice could not be delivered'); }
    }
  } finally {
    // Drain the initial acknowledgement before clearing, so a late response cannot restore it.
    await acknowledgement;
    await Promise.all([
      ...(nativeSlack && slackToken ? [status('active')] : []),
      ...(eyesAdded && slackToken ? [removeSlackReaction({ ...reaction, token: slackToken }).catch(() => { console.warn('Codex eyes acknowledgement could not be removed'); })] : []),
    ]);
  }
}

async function handleTurn(
  message: SlackThreadMessage,
  context: SlackTurnContext,
): Promise<void> {
  // Keyed by channel only, so the agent has the whole channel's context rather
  // than a private thread of its own with each person.
  const sessionKey = slackSessionKey(message.channelId);
  const startedAt = Date.now();
  let slackToken: string | undefined;
  let placeholderTs: string | undefined;

  try {
    slackToken = await mintSlackToken(context.budget, context.oidcToken);
    // Post the placeholder before waking anything: the wake alone is ~10s, and
    // an unanswered mention is indistinguishable from a broken agent. Failure to
    // post it is not fatal, it just means `settle` posts a fresh message instead.
    try {
      placeholderTs = (
        await postReply(message, THINKING_TEXT, context.budget, slackToken)
      ).ts;
    } catch (err) {
      console.warn(`Slack thinking placeholder failed for ${sessionKey}:`, err);
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

    await settle(message, placeholderTs, reply, context.budget, slackToken);
    console.info(`slack turn complete session=${sessionKey} durationMs=${Date.now() - startedAt}`);
  } catch (err) {
    console.error(`turn failed for ${sessionKey}:`, err);
    // Say something rather than leaving the mention unanswered. Deliberately
    // generic: error text can carry paths, tokens, and internals. Editing the
    // placeholder also clears it, so a failed turn cannot leave "Thinking…" as
    // the last word in the thread.
    try {
      slackToken ??= await mintSlackToken(context.budget, context.oidcToken);
      await settle(
        message,
        placeholderTs,
        'Something went wrong handling that. Check the logs.',
        context.budget,
        slackToken,
      );
    } catch (postErr) {
      console.error('failed to post the failure notice:', postErr);
    }
  }
}

/**
 * Puts final text in front of the user: edits the placeholder when there is one,
 * posts a fresh message when it never made it.
 *
 * Editing rather than posting keeps one message per turn, so the thread reads as
 * a question and an answer instead of a progress log.
 */
async function settle(
  message: SlackReplyTarget,
  placeholderTs: string | undefined,
  text: string,
  budget: ExecutionBudget,
  token: string,
): Promise<void> {
  if (placeholderTs) {
    await updateSlackMessage({
      token,
      channelId: message.channelId,
      ts: placeholderTs,
      text,
      budget,
    });
    return;
  }
  await postReply(message, text, budget, token);
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
          scopes: ['chat:write', 'reactions:write', ...(process.env.OPENCLAW_CODEX_NATIVE_SLACK === '1' ? ['channels:history', 'channels:read', 'users:read'] : [])],
        },
        { vercelToken },
    ),
    { capMs: 10_000, reserveReply: false },
  );
}

/**
 * Posts a message in the originating thread and passes back its timestamp, so
 * the placeholder can be edited later.
 */
async function postReply(
  message: SlackReplyTarget,
  text: string,
  budget: ExecutionBudget,
  token: string,
): Promise<{ ts?: string }> {
  return postSlackReply({
    token,
    channelId: message.channelId,
    threadTs: message.threadTs,
    text,
    budget,
  });
}
