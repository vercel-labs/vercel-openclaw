/**
 * Slack event payload + signed-Request builders for L4-host smoke scenarios.
 *
 * These extend the simpler `buildSlackWebhook()` in webhook-builders.ts with
 * explicit shapes for the two events L4-host needs to drive end-to-end:
 *
 *   - `app_mention` (user-initiated wake)
 *   - `message` with `bot_id` (bot reply that should clear pending-boot state)
 *
 * Both payloads accept `threadTs` so scenarios can verify the thread-rooted
 * cleanup path. The "no-thread" omission is the configuration that today
 * leaves the "🦞 Almost ready…" boot message dangling in production.
 */

import * as crypto from "node:crypto";

const DEFAULT_TEAM_ID = "T0E2ETEST";
const DEFAULT_CHANNEL_ID = "C0E2ETEST";
const DEFAULT_USER_ID = "U0E2ETESTHUMAN";
const DEFAULT_BOT_USER_ID = "U0E2ETESTBOT";
const DEFAULT_BOT_ID = "B0E2ETEST";

export type SlackAppMentionOptions = {
  teamId?: string;
  channelId?: string;
  userId?: string;
  botUserId?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
};

export function buildSlackAppMentionPayload(
  options: SlackAppMentionOptions = {},
): Record<string, unknown> {
  const teamId = options.teamId ?? DEFAULT_TEAM_ID;
  const channelId = options.channelId ?? DEFAULT_CHANNEL_ID;
  const userId = options.userId ?? DEFAULT_USER_ID;
  const botUserId = options.botUserId ?? DEFAULT_BOT_USER_ID;
  const text = options.text ?? `<@${botUserId}> hello from l4-host`;
  const ts = options.ts ?? `${Math.floor(Date.now() / 1000)}.000100`;

  return {
    token: "verification-token-unused",
    team_id: teamId,
    api_app_id: "A0E2ETEST",
    type: "event_callback",
    event_id: `Ev${ts.replace(".", "")}`,
    event_time: Math.floor(Number(ts)),
    event: {
      type: "app_mention",
      user: userId,
      text,
      ts,
      channel: channelId,
      event_ts: ts,
      team: teamId,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    },
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: botUserId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

export type SlackBotMessageOptions = {
  teamId?: string;
  channelId?: string;
  botId?: string;
  botUserId?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
};

export function buildSlackBotMessagePayload(
  options: SlackBotMessageOptions = {},
): Record<string, unknown> {
  const teamId = options.teamId ?? DEFAULT_TEAM_ID;
  const channelId = options.channelId ?? DEFAULT_CHANNEL_ID;
  const botId = options.botId ?? DEFAULT_BOT_ID;
  const botUserId = options.botUserId ?? DEFAULT_BOT_USER_ID;
  const text = options.text ?? "bot reply from l4-host";
  const ts = options.ts ?? `${Math.floor(Date.now() / 1000)}.000200`;

  return {
    token: "verification-token-unused",
    team_id: teamId,
    api_app_id: "A0E2ETEST",
    type: "event_callback",
    event_id: `EvBot${ts.replace(".", "")}`,
    event_time: Math.floor(Number(ts)),
    event: {
      type: "message",
      bot_id: botId,
      user: botUserId,
      text,
      channel: channelId,
      ts,
      event_ts: ts,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    },
    authorizations: [
      {
        enterprise_id: null,
        team_id: teamId,
        user_id: botUserId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

/** Sign a raw body with the same v0 scheme bolt expects. */
export function signSlackPayload(
  rawBody: string,
  signingSecret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): { signature: string; timestamp: string } {
  const baseString = `v0:${timestampSeconds}:${rawBody}`;
  const hex = crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return { signature: `v0=${hex}`, timestamp: String(timestampSeconds) };
}

export type BuildSignedSlackRequestInput = {
  signingSecret: string;
  payload: Record<string, unknown>;
  timestampSeconds?: number;
  url?: string;
};

export function buildSignedSlackRequest(
  input: BuildSignedSlackRequestInput,
): Request {
  const rawBody = JSON.stringify(input.payload);
  const { signature, timestamp } = signSlackPayload(
    rawBody,
    input.signingSecret,
    input.timestampSeconds,
  );
  return new Request(input.url ?? "http://localhost:3000/api/channels/slack/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body: rawBody,
  });
}
