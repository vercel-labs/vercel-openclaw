import assert from "node:assert/strict";
import test from "node:test";

import { createFakeFetch } from "@/test-utils/fake-fetch";

import {
  fetchDiscordApplicationIdentity,
  patchInteractionsEndpoint,
  isPublicUrl,
} from "@/server/channels/discord/application";
import {
  triggerTyping,
  sendChannelMessage,
} from "@/server/channels/discord/discord-api";

// ---------------------------------------------------------------------------
// application.ts – fetchDiscordApplicationIdentity
// ---------------------------------------------------------------------------

test("fetchDiscordApplicationIdentity: returns identity from Discord API", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    Response.json({
      id: "app-123",
      verify_key: "AABBCCDD",
      name: "TestBot",
      bot: { username: "test-bot" },
      interactions_endpoint_url: "https://example.com/webhook",
    }),
  );

  const identity = await fetchDiscordApplicationIdentity(
    "test-bot-token",
    fake.fetch,
  );
  assert.equal(identity.applicationId, "app-123");
  assert.equal(identity.publicKey, "aabbccdd"); // lowercased
  assert.equal(identity.appName, "TestBot");
  assert.equal(identity.botUsername, "test-bot");
  assert.equal(
    identity.currentInteractionsEndpointUrl,
    "https://example.com/webhook",
  );

  // Should send Authorization header with Bot prefix
  const req = fake.requests()[0]!;
  assert.equal(req.headers?.["Authorization"], "Bot test-bot-token");
});

test("fetchDiscordApplicationIdentity: strips Bot prefix from token", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    Response.json({
      id: "app-123",
      verify_key: "aabb",
    }),
  );

  await fetchDiscordApplicationIdentity("Bot already-prefixed", fake.fetch);
  const req = fake.requests()[0]!;
  assert.equal(
    req.headers?.["Authorization"],
    "Bot already-prefixed",
    "Should normalize and re-prefix",
  );
});

test("fetchDiscordApplicationIdentity: throws on 401 with DISCORD_INVALID_BOT_TOKEN", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    new Response("Unauthorized", { status: 401 }),
  );

  await assert.rejects(
    fetchDiscordApplicationIdentity("bad-token", fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        "code" in error &&
          (error as Record<string, unknown>).code ===
            "DISCORD_INVALID_BOT_TOKEN",
      );
      return true;
    },
  );
});

test("fetchDiscordApplicationIdentity: throws on 429 rate limit", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    new Response("Rate Limited", { status: 429 }),
  );

  await assert.rejects(
    fetchDiscordApplicationIdentity("token", fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        "code" in error &&
          (error as Record<string, unknown>).code === "DISCORD_RATE_LIMITED",
      );
      return true;
    },
  );
});

test("fetchDiscordApplicationIdentity: throws on 500+ upstream error", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    new Response("Server Error", { status: 502 }),
  );

  await assert.rejects(
    fetchDiscordApplicationIdentity("token", fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        "code" in error &&
          (error as Record<string, unknown>).code === "DISCORD_UPSTREAM_ERROR",
      );
      return true;
    },
  );
});

test("fetchDiscordApplicationIdentity: throws when response missing required fields", async () => {
  const fake = createFakeFetch();
  fake.onGet("discord.com/api/v10/applications/@me", () =>
    Response.json({ id: "app-123" }), // missing verify_key
  );

  await assert.rejects(
    fetchDiscordApplicationIdentity("token", fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// application.ts – patchInteractionsEndpoint
// ---------------------------------------------------------------------------

test("patchInteractionsEndpoint: sends PATCH with correct payload", async () => {
  const fake = createFakeFetch();
  fake.onPatch("discord.com/api/v10/applications/@me", () =>
    new Response(null, { status: 200 }),
  );

  await patchInteractionsEndpoint(
    "bot-token",
    "https://example.com/webhook",
    fake.fetch,
  );

  const req = fake.requests()[0]!;
  assert.equal(req.method, "PATCH");
  assert.ok(req.url.includes("applications/@me"));
  assert.equal(req.headers?.["Authorization"], "Bot bot-token");
  const body = JSON.parse(req.body!);
  assert.equal(body.interactions_endpoint_url, "https://example.com/webhook");
});

test("patchInteractionsEndpoint: throws DISCORD_ENDPOINT_INVALID on 400", async () => {
  const fake = createFakeFetch();
  fake.onPatch("discord.com/api/v10/applications/@me", () =>
    new Response("Bad Request", { status: 400 }),
  );

  await assert.rejects(
    patchInteractionsEndpoint("token", "https://bad.url", fake.fetch),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        "code" in error &&
          (error as Record<string, unknown>).code ===
            "DISCORD_ENDPOINT_INVALID",
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// application.ts – isPublicUrl
// ---------------------------------------------------------------------------

test("isPublicUrl: accepts valid https URLs", () => {
  assert.equal(isPublicUrl("https://example.com/webhook"), true);
});

test("isPublicUrl: rejects http URLs", () => {
  assert.equal(isPublicUrl("http://example.com/webhook"), false);
});

test("isPublicUrl: rejects localhost URLs", () => {
  assert.equal(isPublicUrl("https://localhost:3000/webhook"), false);
  assert.equal(isPublicUrl("https://127.0.0.1/webhook"), false);
  assert.equal(isPublicUrl("https://0.0.0.0/webhook"), false);
});

// ---------------------------------------------------------------------------
// discord-api.ts – triggerTyping
// ---------------------------------------------------------------------------

test("triggerTyping: POSTs to correct Discord endpoint", async () => {
  const fake = createFakeFetch();
  fake.onPost("discord.com/api/v10/channels/chan-1/typing", () =>
    new Response(null, { status: 204 }),
  );

  await triggerTyping("chan-1", "bot-token", { fetchFn: fake.fetch });

  const req = fake.requests()[0]!;
  assert.equal(req.method, "POST");
  assert.ok(req.url.includes("/channels/chan-1/typing"));
  assert.equal(req.headers?.["Authorization"], "Bot bot-token");
});

test("triggerTyping: throws on non-204 response", async () => {
  const fake = createFakeFetch();
  fake.onPost("discord.com/api/v10/channels/chan-1/typing", () =>
    new Response("Forbidden", { status: 403 }),
  );

  await assert.rejects(
    triggerTyping("chan-1", "bot-token", { fetchFn: fake.fetch }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("discord_trigger_typing_failed"));
      assert.ok(error.message.includes("403"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// discord-api.ts – sendChannelMessage
// ---------------------------------------------------------------------------

test("sendChannelMessage: POSTs to correct endpoint with content", async () => {
  const fake = createFakeFetch();
  fake.onPost("discord.com/api/v10/channels/chan-1/messages", () =>
    Response.json({ id: "msg-1" }),
  );

  await sendChannelMessage("chan-1", "bot-token", "Hello world", {
    fetchFn: fake.fetch,
  });

  const req = fake.requests()[0]!;
  assert.equal(req.method, "POST");
  assert.ok(req.url.includes("/channels/chan-1/messages"));
  assert.equal(req.headers?.["Authorization"], "Bot bot-token");
  assert.equal(req.headers?.["Content-Type"], "application/json");

  const body = JSON.parse(req.body!);
  assert.equal(body.content, "Hello world");
  assert.equal(body.allowed_mentions, undefined);
});

test("sendChannelMessage: includes allowed_mentions when userId provided", async () => {
  const fake = createFakeFetch();
  fake.onPost("discord.com/api/v10/channels/chan-1/messages", () =>
    Response.json({ id: "msg-1" }),
  );

  await sendChannelMessage("chan-1", "bot-token", "Hello <@user-1>", {
    fetchFn: fake.fetch,
    allowedMentionsUserId: "user-1",
  });

  const body = JSON.parse(fake.requests()[0]!.body!);
  assert.deepEqual(body.allowed_mentions, {
    users: ["user-1"],
    parse: [],
  });
});
