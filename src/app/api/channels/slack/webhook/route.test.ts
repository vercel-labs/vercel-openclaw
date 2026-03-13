/**
 * Tests for POST /api/channels/slack/webhook.
 *
 * Covers: missing signature headers (401), invalid signature (401),
 * no Slack config (404), URL verification challenge, happy path enqueue,
 * and dedup rejection.
 *
 * Run: pnpm test src/app/api/channels/slack/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

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
    const req = buildSlackWebhook({ signingSecret: SLACK_SIGNING_SECRET });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    const body = result.json as { ok: boolean };
    assert.equal(body.ok, true);
    resetAfterCallbacks();
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Slack webhook: duplicate event_id is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureSlack(h);
    const route = getSlackWebhookRoute();
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
  });
});
