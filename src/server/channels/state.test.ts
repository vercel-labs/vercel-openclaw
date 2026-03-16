import assert from "node:assert/strict";
import test from "node:test";

import type { SingleMeta } from "@/shared/types";
import { createDefaultMeta } from "@/shared/types";
import type {
  SlackChannelConfig,
  TelegramChannelConfig,
  DiscordChannelConfig,
} from "@/shared/channels";
import { withHarness } from "@/test-utils/harness";
import {
  getPublicChannelState,
  buildSlackWebhookUrl,
  buildTelegramWebhookUrl,
  buildDiscordPublicWebhookUrl,
  createTelegramWebhookSecret,
  setSlackChannelConfig,
  setTelegramChannelConfig,
  setDiscordChannelConfig,
} from "@/server/channels/state";

function makeRequest(url = "https://app.example.com"): Request {
  return new Request(url, {
    headers: { host: new URL(url).host },
  });
}

function makeSlackConfig(overrides: Partial<SlackChannelConfig> = {}): SlackChannelConfig {
  return {
    signingSecret: "slack-signing-secret",
    botToken: "xoxb-slack-token",
    configuredAt: 1000,
    ...overrides,
  };
}

function makeTelegramConfig(overrides: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
  return {
    botToken: "tg-bot-token",
    webhookSecret: "tg-webhook-secret",
    webhookUrl: "https://app.example.com/api/channels/telegram/webhook",
    botUsername: "test_bot",
    configuredAt: 2000,
    ...overrides,
  };
}

function makeDiscordConfig(overrides: Partial<DiscordChannelConfig> = {}): DiscordChannelConfig {
  return {
    publicKey: "discord-pub-key",
    applicationId: "discord-app-id",
    botToken: "discord-bot-token",
    configuredAt: 3000,
    ...overrides,
  };
}

test("unconfigured channels return configured: false", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.slack.configured, false);
    assert.equal(state.telegram.configured, false);
    assert.equal(state.discord.configured, false);
  });
});

test("each channel includes a connectability field", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.ok(state.slack.connectability, "slack missing connectability");
    assert.equal(state.slack.connectability.channel, "slack");
    assert.ok(typeof state.slack.connectability.canConnect === "boolean");
    assert.ok(Array.isArray(state.slack.connectability.issues));

    assert.ok(state.telegram.connectability, "telegram missing connectability");
    assert.equal(state.telegram.connectability.channel, "telegram");

    assert.ok(state.discord.connectability, "discord missing connectability");
    assert.equal(state.discord.connectability.channel, "discord");
  });
});

test("configured slack returns correct public shape", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.slack = makeSlackConfig({
        team: "T-TEAM",
        user: "U-USER",
        botId: "B-BOT",
        lastError: "some error",
      });
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.slack.configured, true);
    assert.equal(state.slack.configuredAt, 1000);
    assert.equal(state.slack.team, "T-TEAM");
    assert.equal(state.slack.user, "U-USER");
    assert.equal(state.slack.botId, "B-BOT");
    assert.equal(state.slack.hasSigningSecret, true);
    assert.equal(state.slack.hasBotToken, true);
    assert.equal(state.slack.lastError, "some error");
    // Secrets should NOT be exposed
    assert.equal("signingSecret" in state.slack, false);
    assert.equal("botToken" in state.slack, false);
  });
});

test("configured telegram returns correct public shape", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = makeTelegramConfig();
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.telegram.configured, true);
    assert.equal(state.telegram.botUsername, "test_bot");
    assert.equal(state.telegram.configuredAt, 2000);
    assert.equal(state.telegram.status, "connected");
    assert.ok(state.telegram.webhookUrl);
  });
});

test("telegram with lastError shows error status", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.telegram = makeTelegramConfig({ lastError: "timeout" });
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.telegram.status, "error");
    assert.equal(state.telegram.lastError, "timeout");
  });
});

test("unconfigured telegram shows disconnected status and null webhookUrl", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.telegram.status, "disconnected");
    assert.equal(state.telegram.webhookUrl, null);
  });
});

test("configured discord returns invite url and public shape", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = makeDiscordConfig({
        appName: "TestBot",
        botUsername: "testbot#1234",
        endpointConfigured: true,
        endpointUrl: "https://app.example.com/api/channels/discord/webhook",
        commandRegistered: true,
        commandId: "cmd-123",
      });
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.discord.configured, true);
    assert.equal(state.discord.applicationId, "discord-app-id");
    assert.equal(state.discord.publicKey, "discord-pub-key");
    assert.equal(state.discord.appName, "TestBot");
    assert.equal(state.discord.endpointConfigured, true);
    assert.equal(state.discord.commandRegistered, true);
    assert.equal(state.discord.commandId, "cmd-123");
    assert.ok(state.discord.inviteUrl?.includes("discord-app-id"));
    // Secret should NOT be exposed
    assert.equal("botToken" in state.discord, false);
  });
});

test("discord without applicationId returns null inviteUrl", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.discord.inviteUrl, null);
  });
});

test("webhook URLs are derived from request origin", async () => {
  await withHarness(async (h) => {
    const meta = await h.getMeta();
    const state = await getPublicChannelState(
      makeRequest("https://my-app.vercel.app/api/status"),
      meta,
    );

    assert.ok(state.slack.webhookUrl.startsWith("https://my-app.vercel.app"));
    assert.ok(state.slack.webhookUrl.includes("/api/channels/slack/webhook"));
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: webhook URL builders
// ---------------------------------------------------------------------------

test("[state] buildSlackWebhookUrl -> returns /api/channels/slack/webhook path", async () => {
  await withHarness(async () => {
    const url = buildSlackWebhookUrl(makeRequest("https://my.app.com/some/path"));
    assert.equal(url, "https://my.app.com/api/channels/slack/webhook");
  });
});

test("[state] buildTelegramWebhookUrl -> returns /api/channels/telegram/webhook path", async () => {
  await withHarness(async () => {
    const url = buildTelegramWebhookUrl(makeRequest("https://my.app.com"));
    assert.equal(url, "https://my.app.com/api/channels/telegram/webhook");
  });
});

test("[state] buildDiscordPublicWebhookUrl -> returns /api/channels/discord/webhook path", async () => {
  await withHarness(async () => {
    const url = buildDiscordPublicWebhookUrl(makeRequest("https://my.app.com"));
    assert.ok(url.includes("/api/channels/discord/webhook"));
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: createTelegramWebhookSecret properties
// ---------------------------------------------------------------------------

test("[state] createTelegramWebhookSecret -> returns base64url string of sufficient length", async () => {
  const secret = createTelegramWebhookSecret();
  assert.ok(typeof secret === "string");
  // 24 random bytes base64url-encoded = 32 chars
  assert.ok(secret.length >= 20, `Secret too short: ${secret.length}`);
  // Should not contain characters outside base64url
  assert.ok(/^[A-Za-z0-9_-]+$/.test(secret), "Should be valid base64url");

  // Two calls should produce different secrets
  const secret2 = createTelegramWebhookSecret();
  assert.notEqual(secret, secret2);
});

// ---------------------------------------------------------------------------
// Edge-branch: queueDepth from actual queued items
// ---------------------------------------------------------------------------

test("[state] getPublicChannelState -> queueDepth reflects enqueued items", async () => {
  await withHarness(async (h) => {
    const store = h.getStore();
    // Enqueue a couple of items directly
    await store.enqueue("openclaw-single:channels:slack:queue", "job-1");
    await store.enqueue("openclaw-single:channels:slack:queue", "job-2");

    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.slack.queueDepth, 2);
    assert.equal(state.telegram.queueDepth, 0);
    assert.equal(state.discord.queueDepth, 0);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: setter functions round-trip
// ---------------------------------------------------------------------------

test("[state] setSlackChannelConfig -> persists and clears slack config", async () => {
  await withHarness(async (h) => {
    const config = makeSlackConfig({ team: "T-SET" });
    await setSlackChannelConfig(config);
    const meta = await h.getMeta();
    assert.equal(meta.channels.slack?.team, "T-SET");

    // Clear it
    await setSlackChannelConfig(null);
    const cleared = await h.getMeta();
    assert.equal(cleared.channels.slack, null);
  });
});

test("[state] setTelegramChannelConfig -> persists and clears telegram config", async () => {
  await withHarness(async (h) => {
    const config = makeTelegramConfig({ botUsername: "set_bot" });
    await setTelegramChannelConfig(config);
    const meta = await h.getMeta();
    assert.equal(meta.channels.telegram?.botUsername, "set_bot");

    await setTelegramChannelConfig(null);
    const cleared = await h.getMeta();
    assert.equal(cleared.channels.telegram, null);
  });
});

test("[state] setDiscordChannelConfig -> persists and clears discord config", async () => {
  await withHarness(async (h) => {
    const config = makeDiscordConfig({ appName: "SetBot" });
    await setDiscordChannelConfig(config);
    const meta = await h.getMeta();
    assert.equal(meta.channels.discord?.appName, "SetBot");

    await setDiscordChannelConfig(null);
    const cleared = await h.getMeta();
    assert.equal(cleared.channels.discord, null);
  });
});

// ---------------------------------------------------------------------------
// Edge-branch: Discord error/URL fields
// ---------------------------------------------------------------------------

test("[state] discord endpointError and endpointUrl -> reflected in public state", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = makeDiscordConfig({
        endpointError: "registration failed",
        endpointUrl: "https://my.app/api/channels/discord/webhook",
        endpointConfigured: false,
      });
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.discord.endpointError, "registration failed");
    assert.equal(state.discord.endpointUrl, "https://my.app/api/channels/discord/webhook");
    assert.equal(state.discord.endpointConfigured, false);
  });
});

test("[state] discord without optional fields -> returns null defaults", async () => {
  await withHarness(async (h) => {
    await h.mutateMeta((meta) => {
      meta.channels.discord = makeDiscordConfig();
    });
    const meta = await h.getMeta();
    const state = await getPublicChannelState(makeRequest(), meta);

    assert.equal(state.discord.appName, null);
    assert.equal(state.discord.botUsername, null);
    assert.equal(state.discord.endpointUrl, null);
    assert.equal(state.discord.endpointError, null);
    assert.equal(state.discord.commandId, null);
    assert.equal(state.discord.commandRegistered, false);
  });
});

// ---------------------------------------------------------------------------
// Regression: Discord webhook URL bypass secret behavior
// ---------------------------------------------------------------------------

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("[regression] buildDiscordPublicWebhookUrl includes bypass secret in admin-secret mode", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "admin-secret",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
    },
    () => {
      const request = new Request("https://app.example.com/admin", {
        headers: {
          host: "app.example.com",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(
        buildDiscordPublicWebhookUrl(request),
        "https://app.example.com/api/channels/discord/webhook?x-vercel-protection-bypass=bypass-secret",
      );
    },
  );
});

test("[regression] buildDiscordPublicWebhookUrl includes bypass secret when available regardless of auth mode", async () => {
  await withEnv(
    {
      VERCEL_AUTH_MODE: "sign-in-with-vercel",
      VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      NEXT_PUBLIC_BASE_DOMAIN: undefined,
      BASE_DOMAIN: undefined,
    },
    () => {
      const request = new Request("https://app.example.com/admin", {
        headers: {
          host: "app.example.com",
          "x-forwarded-proto": "https",
        },
      });

      assert.equal(
        buildDiscordPublicWebhookUrl(request),
        "https://app.example.com/api/channels/discord/webhook?x-vercel-protection-bypass=bypass-secret",
      );
    },
  );
});
