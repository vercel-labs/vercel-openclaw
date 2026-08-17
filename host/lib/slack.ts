/**
 * The Slack side of the front door.
 *
 * The Vercel app owns the Slack channel outright: Vercel Connect verifies the
 * event and forwards it here, we decide whether to act, hand OpenClaw the
 * message text, and post the reply ourselves with a token minted per call. No
 * Slack credential ever reaches the sandbox.
 *
 * Parsing and posting are kept apart so the routing rules are testable without
 * a network or a workspace.
 */
import {
  createExecutionBudget,
  operationTimeoutMs,
  type ExecutionBudget,
} from './execution-budget';

export interface SlackReplyTarget {
  channelId: string;
  /** Thread to reply in: the parent when threaded, else the message itself. */
  threadTs: string;
}

export interface SlackReactionTarget {
  channelId: string;
  /** Timestamp of the exact Slack message receiving the reaction. */
  messageTs: string;
}

export interface SlackThreadMessage extends SlackReplyTarget {
  text: string;
  userId: string;
  /** Timestamp of the triggering message, which may be a thread reply. */
  messageTs: string;
}

/** Shape we care about from Slack's Events API envelope. */
export interface InboundSlackMessage extends SlackThreadMessage {
  eventId?: string;
}

export type SlackParseResult =
  | { handle: true; message: InboundSlackMessage }
  | { handle: false; reason: string };

/**
 * Decides whether a forwarded Slack event should start an agent turn.
 *
 * Handles `app_mention` anywhere, and `message` events in a DM. Everything else
 * is ignored, including:
 *
 *   - anything authored by a bot or by this app, which is what prevents a
 *     self-reply loop, since our own replies come back as events
 *   - message subtypes (edits, deletions, joins, file shares), which are not
 *     user turns
 *   - channel messages that are not mentions, so the agent does not answer
 *     every line of conversation in a channel it was invited to
 */
export function parseSlackEvent(body: unknown): SlackParseResult {
  const envelope = body as {
    type?: unknown;
    event_id?: unknown;
    event?: Record<string, unknown>;
  } | null;

  if (envelope?.type !== 'event_callback' || !envelope.event) {
    return { handle: false, reason: `unsupported envelope type: ${String(envelope?.type)}` };
  }

  const event = envelope.event;
  const eventType = event.type;

  // Bot-authored messages never start a turn. Checked before anything else so a
  // reply of ours can never trigger another turn.
  if (event.bot_id !== undefined || event.bot_profile !== undefined) {
    return { handle: false, reason: 'bot-authored' };
  }
  // `subtype` marks edits, joins, file shares and similar. None is a user turn.
  if (typeof event.subtype === 'string') {
    return { handle: false, reason: `message subtype: ${event.subtype}` };
  }

  const isDirectMessage = event.channel_type === 'im';
  if (eventType !== 'app_mention' && !(eventType === 'message' && isDirectMessage)) {
    return { handle: false, reason: `not a mention or DM: ${String(eventType)}` };
  }

  const channelId = typeof event.channel === 'string' ? event.channel : '';
  const ts = typeof event.ts === 'string' ? event.ts : '';
  const userId = typeof event.user === 'string' ? event.user : '';
  if (!channelId || !ts || !userId) {
    return { handle: false, reason: 'missing channel, ts, or user' };
  }

  const threadTs = typeof event.thread_ts === 'string' && event.thread_ts ? event.thread_ts : ts;
  const rawText = typeof event.text === 'string' ? event.text : '';

  return {
    handle: true,
    message: {
      eventId: typeof envelope.event_id === 'string' ? envelope.event_id : undefined,
      userId,
      channelId,
      messageTs: ts,
      threadTs,
      text: stripMentions(rawText),
    },
  };
}

/**
 * Removes Slack's `<@U123>` mention tokens.
 *
 * The agent should see "what is the deploy status", not "<@U0BOT> what is the
 * deploy status". Slack renders mentions as opaque ids, so leaving them in
 * spends context on a token the model cannot resolve.
 */
export function stripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Placeholder posted the moment a turn is accepted, then edited into the answer.
 *
 * A wake plus a turn takes tens of seconds, and until something appears in the
 * thread the mention looks ignored. Italics mark it as transient rather than as
 * the agent's own words.
 */
export const THINKING_TEXT = '_Thinking…_';

/**
 * Posts a reply in thread and returns its timestamp.
 *
 * The `ts` is what makes the placeholder editable: `updateSlackMessage` needs it
 * to turn this message into the final answer instead of posting a second one.
 *
 * The token is passed in rather than read here, because it is minted per call
 * through Vercel Connect and the caller owns that lifecycle.
 */
export async function postSlackReply(options: SlackReplyTarget & {
  token: string;
  text: string;
  budget?: ExecutionBudget;
}): Promise<{ ts?: string }> {
  const requestTimeoutMs = operationTimeoutMs(
    options.budget ?? createExecutionBudget(),
    'Slack reply',
    { capMs: 10_000, reserveReply: false },
  );
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: options.channelId,
      thread_ts: options.threadTs,
      text: options.text,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  // Slack answers 200 with `ok: false` for application errors, so the status
  // code alone proves nothing.
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    ts?: string;
  };
  if (!res.ok || !data.ok) {
    throw new Error(`chat.postMessage failed: status=${res.status} error=${data.error ?? 'unknown'}`);
  }
  // Optional on purpose: a send that succeeded without a usable `ts` should
  // still count as sent. The caller falls back to posting a fresh message.
  return { ts: typeof data.ts === 'string' ? data.ts : undefined };
}

/**
 * Edits a message in place, which is how the placeholder becomes the answer.
 *
 * Uses `chat:write`, the same scope `chat.postMessage` already needs, so this
 * adds no Connect scope and no reinstall.
 */
export async function updateSlackMessage(options: {
  token: string;
  channelId: string;
  ts: string;
  text: string;
  budget?: ExecutionBudget;
}): Promise<void> {
  const requestTimeoutMs = operationTimeoutMs(
    options.budget ?? createExecutionBudget(),
    'Slack message update',
    { capMs: 10_000, reserveReply: false },
  );
  const res = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: options.channelId,
      ts: options.ts,
      text: options.text,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(`chat.update failed: status=${res.status} error=${data.error ?? 'unknown'}`);
  }
}

/** Adds a visible progress acknowledgement to the triggering Slack message. */
export async function postSlackReaction(options: SlackReactionTarget & {
  token: string;
  name: string;
  budget?: ExecutionBudget;
}): Promise<void> {
  await changeSlackReaction('add', options);
}

/** Removes a progress acknowledgement after the final reply is posted. */
export async function removeSlackReaction(options: SlackReactionTarget & {
  token: string;
  name: string;
  budget?: ExecutionBudget;
}): Promise<void> {
  await changeSlackReaction('remove', options);
}

async function changeSlackReaction(
  method: 'add' | 'remove',
  options: SlackReactionTarget & {
    token: string;
    name: string;
    budget?: ExecutionBudget;
  },
): Promise<void> {
  const requestTimeoutMs = operationTimeoutMs(
    options.budget ?? createExecutionBudget(),
    'Slack reaction',
    { capMs: 10_000, reserveReply: false },
  );
  const res = await fetch(`https://slack.com/api/reactions.${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: options.channelId,
      timestamp: options.messageTs,
      name: options.name,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(
      `reactions.${method} failed: status=${res.status} error=${data.error ?? 'unknown'}`,
    );
  }
}
