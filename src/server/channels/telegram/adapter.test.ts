import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramAdapter,
  isTelegramWebhookSecretValid,
} from "@/server/channels/telegram/adapter";

test("isTelegramWebhookSecretValid accepts current and unexpired previous secrets", () => {
  const now = Date.now();
  const config = {
    botToken: "bot-token",
    webhookSecret: "current-secret",
    previousWebhookSecret: "previous-secret",
    previousSecretExpiresAt: now + 60_000,
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: now,
  };

  assert.equal(isTelegramWebhookSecretValid(config, "current-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now), true);
  assert.equal(isTelegramWebhookSecretValid(config, "previous-secret", now + 120_000), false);
});

test("createTelegramAdapter extracts chat text updates", async () => {
  const adapter = createTelegramAdapter({
    botToken: "bot-token",
    webhookSecret: "secret",
    webhookUrl: "https://example.com/api/channels/telegram/webhook",
    botUsername: "openclaw_bot",
    configuredAt: Date.now(),
  });

  const result = await adapter.extractMessage({
    update_id: 1,
    message: {
      text: "hello telegram",
      chat: {
        id: 42,
      },
    },
  });

  assert.equal(result.kind, "message");
  if (result.kind !== "message") {
    return;
  }

  assert.equal(result.message.text, "hello telegram");
  assert.equal(result.message.chatId, "42");
});
