/**
 * L4-host scenario 4: boot-cleanup-no-thread (currently failing).
 *
 * Reproduces the production bug where "🦞 Almost ready…" boot placeholders
 * are left dangling after a wake roundtrip when the user message and the
 * agent's reply are both at the channel root (no thread).
 *
 * Write side (drain-channel-workflow.ts:1161-1167):
 *   threadRoot = event.thread_ts ?? event.ts          // == userTs when top-level
 *   key        = pending-boot:<channel>:<threadRoot>  // == :<userTs>
 *
 * Read side (slack/webhook/route.ts:286-358):
 *   botReplyRoot = botReply.thread_ts ?? botReply.ts  // == botReplyTs when top-level
 *   key          = pending-boot:<channel>:<botReplyRoot>  // == :<botReplyTs>  ← MISMATCH
 *
 * Today, the threaded variant works because both sides see thread_ts ==
 * threadRoot. The no-thread variant fails because the bot reply's own ts is
 * different from the user message ts.
 *
 * Asserts (currently expected to fail until route.ts is fixed):
 *   - chat.delete is invoked for the boot ts
 *   - no pending-boot entry remains under any candidate scope
 *
 * The threaded sibling test stays green and protects the intended behaviour.
 *
 * Run: npm test src/test-utils/host-smoke/l4-host-boot-cleanup.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getStore } from "@/server/store/store";
import { channelPendingBootMessageKey } from "@/server/store/keyspace";
import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import { callRoute, getSlackWebhookRoute, resetAfterCallbacks } from "@/test-utils/route-caller";
import {
  buildSignedSlackRequest,
  buildSlackBotMessagePayload,
} from "@/test-utils/host-smoke/slack-events";
import { readPendingBootEntries } from "@/test-utils/host-smoke/store-inspector";
import { slackOkResponse } from "@/test-utils/fake-fetch";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-l4-host";
const CHANNEL_ID = "C0L4HOST";
const BOT_USER_ID = "U0L4HOSTBOT";
const BOT_ID = "B0L4HOSTBOT";
const USER_TS = "1740000000.000001";
const BOT_TS = "1740000010.000002";
const BOOT_TS = "1740000005.000099";

async function configureSlack(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SLACK_SIGNING_SECRET,
      botToken: "xoxb-test-bot-token-l4-host",
      configuredAt: Date.now(),
    };
  });
}

/**
 * Mirror what drainChannelWorkflow does after a successful wake forward:
 * append the boot ts to pending-boot:<channel>[:<threadTs>]. Threaded
 * messages scope by Slack's `thread_ts`; top-level messages share a
 * channel-wide list at scope=undefined (the bot reply has no thread_ts and
 * its own ts is unrelated to the user message ts).
 */
async function seedPendingBoot(
  channelId: string,
  scope: string | undefined,
  bootTs: string,
) {
  const key = channelPendingBootMessageKey("slack", channelId, scope);
  await getStore().setValue(key, [bootTs], 3600);
}

function chatDeleteCalls(
  h: ScenarioHarness,
): Array<{ channel: string; ts: string }> {
  const calls: Array<{ channel: string; ts: string }> = [];
  for (const req of h.fakeFetch.requests()) {
    if (req.method.toUpperCase() !== "POST") continue;
    if (!req.url.includes("slack.com/api/chat.delete")) continue;
    if (!req.body) continue;
    try {
      const parsed = JSON.parse(req.body) as { channel?: string; ts?: string };
      if (typeof parsed.channel === "string" && typeof parsed.ts === "string") {
        calls.push({ channel: parsed.channel, ts: parsed.ts });
      }
    } catch {
      // ignore malformed test bodies
    }
  }
  return calls;
}

test("L4-host: boot cleanup runs when bot replies in same thread (threaded sibling, control)", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    // Threaded variant: user message at USER_TS, bot reply uses thread_ts=USER_TS.
    // Workflow scopes pending-boot by thread_ts=USER_TS; cleanup looks up the
    // same scope.
    await seedPendingBoot(CHANNEL_ID, USER_TS, BOOT_TS);

    const route = getSlackWebhookRoute();
    const req = buildSignedSlackRequest({
      signingSecret: SLACK_SIGNING_SECRET,
      payload: buildSlackBotMessagePayload({
        channelId: CHANNEL_ID,
        botId: BOT_ID,
        botUserId: BOT_USER_ID,
        ts: BOT_TS,
        threadTs: USER_TS,
      }),
    });

    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200, "bot reply must return 200");

      const deletes = chatDeleteCalls(h);
      assert.equal(deletes.length, 1, `expected exactly one chat.delete (got ${deletes.length})`);
      assert.equal(deletes[0].channel, CHANNEL_ID);
      assert.equal(deletes[0].ts, BOOT_TS);

      const remaining = await readPendingBootEntries("slack", CHANNEL_ID, [
        USER_TS,
        BOT_TS,
        undefined,
      ]);
      assert.equal(
        remaining.length,
        0,
        `pending-boot keys must be cleared (still set: ${JSON.stringify(remaining)})`,
      );
    } finally {
      resetAfterCallbacks();
    }
  });
});

test("L4-host: boot cleanup runs when bot replies at channel root (no thread)", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    h.fakeFetch.onPost(/slack\.com\/api\//, () => slackOkResponse());

    // No-thread variant: user message at channel root, no thread_ts. The
    // workflow now writes to scope=undefined (channel-wide top-level list)
    // because neither side can derive the user's ts from a top-level bot
    // reply. The bot reply has no thread_ts and reads the same undefined
    // scope, so cleanup matches.
    await seedPendingBoot(CHANNEL_ID, undefined, BOOT_TS);

    const route = getSlackWebhookRoute();
    const req = buildSignedSlackRequest({
      signingSecret: SLACK_SIGNING_SECRET,
      payload: buildSlackBotMessagePayload({
        channelId: CHANNEL_ID,
        botId: BOT_ID,
        botUserId: BOT_USER_ID,
        ts: BOT_TS,
        // intentionally omit threadTs — this is the production case that
        // leaves "🦞 Almost ready…" dangling.
      }),
    });

    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200, "bot reply must still return 200");

      const deletes = chatDeleteCalls(h);
      assert.equal(
        deletes.length,
        1,
        `expected one chat.delete for the boot ts; got ${deletes.length}: ${JSON.stringify(deletes)}`,
      );
      assert.equal(deletes[0].channel, CHANNEL_ID);
      assert.equal(deletes[0].ts, BOOT_TS);

      const remaining = await readPendingBootEntries("slack", CHANNEL_ID, [
        USER_TS,
        BOT_TS,
        undefined,
      ]);
      assert.equal(
        remaining.length,
        0,
        `pending-boot keys must be cleared after no-thread bot reply; still set: ${JSON.stringify(remaining)}`,
      );
    } finally {
      resetAfterCallbacks();
    }
  });
});
