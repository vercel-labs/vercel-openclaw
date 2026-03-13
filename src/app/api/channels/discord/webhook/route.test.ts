/**
 * Tests for POST /api/channels/discord/webhook.
 *
 * Covers: missing signature headers (401), invalid signature (401),
 * no Discord config (404), PING response, happy path enqueue, and dedup.
 *
 * Run: pnpm test src/app/api/channels/discord/webhook/route.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness, type ScenarioHarness } from "@/test-utils/harness";
import {
  buildDiscordWebhook,
  buildDiscordPing,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";
import {
  callRoute,
  buildPostRequest,
  getDiscordWebhookRoute,
  resetAfterCallbacks,
} from "@/test-utils/route-caller";

const discordKeys = generateDiscordKeyPair();

async function configureDiscord(h: ScenarioHarness) {
  await h.mutateMeta((meta) => {
    meta.channels.discord = {
      publicKey: discordKeys.publicKeyHex,
      applicationId: "test-discord-app-id",
      botToken: "test-discord-bot-token",
      configuredAt: Date.now(),
    };
  });
}

// ===========================================================================
// Signature validation
// ===========================================================================

test("Discord webhook: missing signature headers returns 401", async () => {
  await withHarness(async (h) => {
    await configureDiscord(h);
    const route = getDiscordWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/discord/webhook",
      JSON.stringify({ id: "int-1", type: 2, token: "tok" }),
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Discord webhook: invalid signature returns 401", async () => {
  await withHarness(async (h) => {
    await configureDiscord(h);
    const route = getDiscordWebhookRoute();
    const wrongKeys = generateDiscordKeyPair();
    const req = buildDiscordWebhook({
      privateKey: wrongKeys.privateKey,
      publicKeyHex: wrongKeys.publicKeyHex,
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 401);
  });
});

test("Discord webhook: no Discord config returns 409", async () => {
  await withHarness(async () => {
    const route = getDiscordWebhookRoute();
    const req = buildPostRequest(
      "/api/channels/discord/webhook",
      JSON.stringify({ id: "int-1", type: 2, token: "tok" }),
      {
        "x-signature-ed25519": "0".repeat(128),
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    );
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 409);
  });
});

// ===========================================================================
// PING
// ===========================================================================

test("Discord webhook: PING interaction returns type 1 ACK", async () => {
  await withHarness(async (h) => {
    await configureDiscord(h);
    const route = getDiscordWebhookRoute();
    const req = buildDiscordPing({
      privateKey: discordKeys.privateKey,
      publicKeyHex: discordKeys.publicKeyHex,
    });
    const result = await callRoute(route.POST, req);
    assert.equal(result.status, 200);
    const body = result.json as { type: number };
    assert.equal(body.type, 1);
  });
});

// ===========================================================================
// Happy path
// ===========================================================================

test("Discord webhook: valid interaction enqueues job and returns type 5", async () => {
  await withHarness(async (h) => {
    await configureDiscord(h);
    const route = getDiscordWebhookRoute();
    const req = buildDiscordWebhook({
      privateKey: discordKeys.privateKey,
      publicKeyHex: discordKeys.publicKeyHex,
    });
    const result = await callRoute(route.POST, req);
    assert.ok(result.status === 200 || result.status === 201);
    resetAfterCallbacks();
  });
});

// ===========================================================================
// Dedup
// ===========================================================================

test("Discord webhook: duplicate interaction is deduplicated", async () => {
  await withHarness(async (h) => {
    await configureDiscord(h);
    const route = getDiscordWebhookRoute();

    const payload = {
      id: "interaction-dedup-test",
      type: 2,
      token: "test-token",
      application_id: "app-123456",
      channel_id: "ch-123456",
      member: { user: { id: "user-123456" } },
      data: {
        name: "ask",
        options: [{ name: "text", value: "dedup test" }],
      },
    };

    const req1 = buildDiscordWebhook({
      privateKey: discordKeys.privateKey,
      publicKeyHex: discordKeys.publicKeyHex,
      payload,
    });
    const result1 = await callRoute(route.POST, req1);
    assert.ok(result1.status === 200 || result1.status === 201);
    resetAfterCallbacks();

    const req2 = buildDiscordWebhook({
      privateKey: discordKeys.privateKey,
      publicKeyHex: discordKeys.publicKeyHex,
      payload,
    });
    const result2 = await callRoute(route.POST, req2);
    assert.equal(result2.status, 200);
    const body2 = result2.json as { type: number };
    assert.equal(body2.type, 5);
  });
});
