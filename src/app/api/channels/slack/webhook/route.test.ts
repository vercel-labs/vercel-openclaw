/**
 * Tests for POST /api/channels/slack/webhook.
 *
 * Covers: missing signature headers (401), invalid signature (401),
 * no Slack config (404), URL verification challenge, happy path enqueue,
 * and dedup rejection.
 *
 * Run: npm test src/app/api/channels/slack/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import {
  channelDedupKey,
  channelUserMessageDedupKey,
} from "@/server/channels/keys";
import { getStore } from "@/server/store/store";
import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import {
  buildSlackWebhook,
  buildSlackUrlVerification,
} from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getSlackWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";
import { slackWebhookWorkflowRuntime } from "@/app/api/channels/slack/webhook/route";

const SLACK_SIGNING_SECRET = "test-slack-signing-secret-direct";

async function configureSlack(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.slack = {
      signingSecret: SLACK_SIGNING_SECRET,
      botToken: "xoxb-test-bot-token",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Signature / auth validation
// ===========================================================================

test("Slack webhook: missing signature headers returns 401", async () => {
  await withHarness(async () => {
    const route = getSlackWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/slack/webhook",
      JSON.stringify({ type: "event_callback" }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Slack webhook: invalid signature returns 401", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const req = buildSlackWebhook({
      signingSecret: "wrong-secret-not-matching",
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Slack webhook: no Slack config returns 404", async () => {
  await withHarness(async () => {
    const route = getSlackWebhookRoute();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const req = buildPostRequest(
      "/api/channels/slack/webhook",
      JSON.stringify({ type: "event_callback" }),
      {
        "x-slack-signature": "v0=fakesig",
        "x-slack-request-timestamp": timestamp,
      },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 404);
  });
});

// ===========================================================================
// URL verification challenge
// ===========================================================================

test("Slack webhook: url_verification returns challenge", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const req = buildSlackUrlVerification(SLACK_SIGNING_SECRET, "my-challenge");
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    assert.equal(result.text, "my-challenge");
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("Slack webhook: valid event enqueues job and returns 200", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      const body = result.json as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: forwards signature headers to the workflow handoff", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
    try {
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.equal(startMock.mock.callCount(), 1);
      // workflowApi.start(workflow, args) — we assert on args (the second arg).
      const call = startMock.mock.calls[0];
      const args = call.arguments?.[1] as unknown[] | undefined;
      assert.ok(Array.isArray(args), "start must be called with args array");
      assert.equal(args.length, 7, "drainChannelWorkflow expects 7 args including handoff");
      const [channel, , , , , , handoff] = args as [
        string,
        unknown,
        string,
        string | null,
        string | null,
        number | null,
        { slackForwardHeaders?: Record<string, string> } | null,
      ];
      assert.equal(channel, "slack");
      assert.ok(handoff, "handoff must be present");
      const headers = handoff.slackForwardHeaders ?? null;
      assert.ok(headers, "slackForwardHeaders must be present on handoff");
      assert.ok(
        typeof headers["x-slack-signature"] === "string"
          && headers["x-slack-signature"].length > 0,
        "x-slack-signature must be captured",
      );
      assert.ok(
        typeof headers["x-slack-request-timestamp"] === "string"
          && headers["x-slack-request-timestamp"].length > 0,
        "x-slack-request-timestamp must be captured",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Slack webhook: duplicate event_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});
    const payload = {
      type: "event_callback",
      event_id: "Ev_DEDUP_TEST",
      event: {
        type: "message",
        text: "hello",
        channel: "C123",
        ts: "1234567890.000001",
        user: "U123",
      },
    };

    try {
      // First request
      const req1 = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
      const result1 = await callRoute(route.POST, req1);
      assert.equal(result1.status, 200);
      resetAfterCallbacks();

      // Second request with same event_id — should be deduped
      const req2 = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
      const result2 = await callRoute(route.POST, req2);
      assert.equal(result2.status, 200);
      const body2 = result2.json as { ok: boolean };
      assert.equal(body2.ok, true);
      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: app_mention + message for same user post collapses to one workflow", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    const channel = "C123";
    const ts = "1234567890.000001";
    const appMention = {
      type: "event_callback",
      event_id: "Ev_APP_MENTION",
      event: { type: "app_mention", text: "@bot hello", channel, ts, user: "U1" },
    };
    const message = {
      type: "event_callback",
      event_id: "Ev_MESSAGE",
      event: { type: "message", text: "@bot hello", channel, ts, user: "U1" },
    };

    try {
      const r1 = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload: appMention }),
      );
      assert.equal(r1.status, 200);
      resetAfterCallbacks();
      const r2 = await callRoute(
        route.POST,
        buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload: message }),
      );
      assert.equal(r2.status, 200);
      assert.equal(
        startMock.mock.callCount(),
        1,
        "second sibling event must not start a second workflow",
      );
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: fast path non-ok response falls through to workflow wake path", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    await h.mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = "sbx-slack-non-ok";
      meta.snapshotId = "snap-slack-non-ok";
      meta.portUrls = {
        "3000": "https://sbx-slack-non-ok-3000.fake.vercel.run",
      };
    });

    h.fakeFetch.onPost(/slack\/events$/, () =>
      new Response("bad gateway", { status: 502 }),
    );

    const route = getSlackWebhookRoute();
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {});

    try {
      const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, { ok: true });
      assert.equal(
        startMock.mock.callCount(),
        1,
        "workflow MUST start when native handler returned non-2xx so the event is not silently dropped",
      );
      resetAfterCallbacks();
    } finally {
      startMock.mock.restore();
    }
  });
});

test("Slack webhook: releases dedup lock and returns 500 when workflow start fails", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
    const payload = {
      type: "event_callback",
      event_id: "Ev_START_FAIL",
      event: {
        type: "message",
        text: "hello",
        channel: "C123",
        ts: "1234567890.000001",
        user: "U123",
      },
    };
    const dedupKey = channelDedupKey("slack", payload.event_id);
    const userMessageDedupKey = channelUserMessageDedupKey(
      "slack",
      payload.event.channel,
      payload.event.ts,
    );
    const startMock = mock.method(slackWebhookWorkflowRuntime, "start", async () => {
      throw new Error("workflow engine unavailable");
    });

    try {
      const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET, payload });
      const result = await callRoute(route.POST, req);
      assert.equal(result.status, 500);
      assert.deepEqual(result.json, {
        ok: false,
        error: "WORKFLOW_START_FAILED",
        retryable: true,
      });

      const reacquiredToken = await getStore().acquireLock(dedupKey, 60);
      assert.ok(reacquiredToken, "dedup lock should be released when workflow start fails");
      await getStore().releaseLock(dedupKey, reacquiredToken!);

      const reacquiredUserMessageToken = await getStore().acquireLock(
        userMessageDedupKey,
        60,
      );
      assert.ok(
        reacquiredUserMessageToken,
        "user-message dedup lock should be released when workflow start fails",
      );
      await getStore().releaseLock(userMessageDedupKey, reacquiredUserMessageToken!);

      assert.equal(startMock.mock.callCount(), 1);
    } finally {
      startMock.mock.restore();
    }
  });
});
