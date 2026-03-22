import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGatewayConfig,
  buildGatewayRestartScript,
  computeGatewayConfigHash,
  GATEWAY_CONFIG_HASH_VERSION,
  buildStartupScript,
  buildWebSearchSkill,
  buildWebSearchScript,
  buildVisionSkill,
  buildVisionScript,
  buildTtsSkill,
  buildTtsScript,
  buildStructuredExtractSkill,
  buildStructuredExtractScript,
  OPENCLAW_TELEGRAM_WEBHOOK_HOST,
  OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
  TELEGRAM_PUBLIC_WEBHOOK_PATH,
} from "@/server/openclaw/config";

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  }
}

test("buildGatewayConfig disables insecure auth by default but always disables device auth", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: undefined,
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, false);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig reads insecure auth toggle from env", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "yes",
    },
    () => {
      const config = JSON.parse(buildGatewayConfig()) as {
        gateway: {
          controlUi: {
            allowInsecureAuth: boolean;
            dangerouslyDisableDeviceAuth: boolean;
          };
        };
      };

      assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
      assert.equal(config.gateway.controlUi.dangerouslyDisableDeviceAuth, true);
    },
  );
});

test("buildGatewayConfig throws for invalid boolean env values", () => {
  withEnv(
    {
      OPENCLAW_ALLOW_INSECURE_AUTH: "maybe",
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: undefined,
    },
    () => {
      assert.throws(
        () => buildGatewayConfig(),
        /OPENCLAW_ALLOW_INSECURE_AUTH must be one of: true, false, 1, 0, yes, no, on, off\./,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// buildGatewayConfig — model aliases and providers
// ---------------------------------------------------------------------------

test("buildGatewayConfig with apiKey includes model aliases and providers", () => {
  const config = JSON.parse(buildGatewayConfig("test-key")) as Record<string, unknown>;

  // Model aliases
  const agents = config.agents as { defaults: { models: Record<string, unknown> } };
  assert.ok(agents.defaults.models["vercel-ai-gateway/openai/gpt-5.3-chat"]);
  assert.ok(agents.defaults.models["vercel-ai-gateway/google/gemini-3.1-flash-image-preview"]);

  // Provider models
  const models = config.models as { providers: { openai: { models: { id: string }[] } } };
  const modelIds = models.providers.openai.models.map((m) => m.id);
  assert.ok(modelIds.includes("gpt-image-1"));
  assert.ok(modelIds.includes("dall-e-3"));
  assert.ok(modelIds.includes("gpt-4o"));
  assert.ok(modelIds.includes("gpt-4o-mini-tts"));
  assert.ok(modelIds.includes("text-embedding-3-small"));
  assert.ok(modelIds.includes("text-embedding-3-large"));

  // Media tools
  const tools = config.tools as { media: { audio: { enabled: boolean } } };
  assert.equal(tools.media.audio.enabled, true);
});

test("buildGatewayConfig omits telegram webhookUrl when proxy origin is missing", () => {
  const withoutOrigin = JSON.parse(
    buildGatewayConfig(undefined, undefined, "test-telegram-token"),
  ) as {
    channels: {
      telegram: Record<string, unknown>;
    };
  };
  assert.equal(
    Object.prototype.hasOwnProperty.call(withoutOrigin.channels.telegram, "webhookUrl"),
    false,
  );

  const withOrigin = JSON.parse(
    buildGatewayConfig(undefined, "https://app.example.com/", "test-telegram-token"),
  ) as {
    channels: {
      telegram: {
        webhookHost: string;
        webhookPath: string;
        webhookUrl?: string;
      };
    };
  };
  assert.equal(withOrigin.channels.telegram.webhookHost, OPENCLAW_TELEGRAM_WEBHOOK_HOST);
  assert.equal(
    withOrigin.channels.telegram.webhookPath,
    OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
  );
  assert.equal(
    withOrigin.channels.telegram.webhookUrl,
    `https://app.example.com${TELEGRAM_PUBLIC_WEBHOOK_PATH}`,
  );
});

// ---------------------------------------------------------------------------
// Skill builders — content assertions
// ---------------------------------------------------------------------------

test("buildWebSearchSkill returns valid skill metadata", () => {
  const skill = buildWebSearchSkill();
  assert.ok(skill.includes("name: web-search"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildWebSearchScript references web_search and chat completions", () => {
  const script = buildWebSearchScript();
  assert.ok(script.includes("web_search"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildVisionSkill returns valid skill metadata", () => {
  const skill = buildVisionSkill();
  assert.ok(skill.includes("name: vision"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildVisionScript references image_url and chat completions", () => {
  const script = buildVisionScript();
  assert.ok(script.includes("image_url"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildTtsSkill returns valid skill metadata", () => {
  const skill = buildTtsSkill();
  assert.ok(skill.includes("name: tts"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildTtsScript uses AI Gateway and outputs MEDIA line", () => {
  const script = buildTtsScript();
  assert.ok(script.includes("ai-gateway.vercel.sh/v1/audio/speech"));
  assert.ok(script.includes("MEDIA:"));
});

test("buildStructuredExtractSkill returns valid skill metadata", () => {
  const skill = buildStructuredExtractSkill();
  assert.ok(skill.includes("name: structured-extract"));
  assert.ok(skill.includes("AI_GATEWAY_API_KEY"));
});

test("buildStructuredExtractScript uses json_schema response format", () => {
  const script = buildStructuredExtractScript();
  assert.ok(script.includes("json_schema"));
  assert.ok(script.includes("response_format"));
});

// ---------------------------------------------------------------------------
// Gateway restart script
// ---------------------------------------------------------------------------

test("buildGatewayRestartScript exits non-zero when gateway token is empty", () => {
  const script = buildGatewayRestartScript();
  assert.ok(script.includes("set -euo pipefail"), "restart script should use strict mode");
  assert.ok(script.includes("exit 1"), "restart script should exit 1 on empty token");
  assert.ok(
    script.includes("empty_gateway_token"),
    "restart script should emit structured error for empty token",
  );
});

test("buildGatewayRestartScript does not touch pairing state", () => {
  const script = buildGatewayRestartScript();
  assert.ok(!script.includes("paired.json"), "restart script must not reference paired.json");
  assert.ok(!script.includes("pending.json"), "restart script must not reference pending.json");
  assert.ok(!script.includes("devices"), "restart script must not reference devices dir");
});

test("buildGatewayRestartScript does not install shell hooks", () => {
  const script = buildGatewayRestartScript();
  assert.ok(!script.includes("shell-commands-for-learning"), "restart script must not install learning hooks");
  assert.ok(!script.includes(".zshrc"), "restart script must not modify .zshrc");
  assert.ok(!script.includes(".bashrc"), "restart script must not modify .bashrc");
});

test("buildGatewayRestartScript kills existing gateway and launches a new one", () => {
  const script = buildGatewayRestartScript();
  assert.ok(script.includes('pkill -f "openclaw.gateway"'), "restart script should kill existing gateway");
  assert.ok(script.includes("openclaw gateway"), "restart script should launch the gateway");
});

test("buildStartupScript and buildGatewayRestartScript share the same gateway launch command", () => {
  const startup = buildStartupScript();
  const restart = buildGatewayRestartScript();

  // Both should use setsid to launch the gateway in the background
  assert.ok(startup.includes("setsid"), "startup script should use setsid launch");
  assert.ok(restart.includes("setsid"), "restart script should use setsid launch");

  // Both should read the gateway token from disk
  assert.ok(startup.includes(".gateway-token"), "startup should read gateway token");
  assert.ok(restart.includes(".gateway-token"), "restart should read gateway token");
});

test("buildStartupScript clears pairing state while restart does not", () => {
  const startup = buildStartupScript();
  const restart = buildGatewayRestartScript();

  assert.ok(startup.includes("paired.json"), "startup should clear paired.json");
  assert.ok(!restart.includes("paired.json"), "restart must not clear paired.json");
});

test("computeGatewayConfigHash returns a stable sha256 hex digest", () => {
  const hash = computeGatewayConfigHash({});

  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("computeGatewayConfigHash returns the same hash for identical inputs", () => {
  const input = {
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "slack-secret",
    },
  };

  assert.equal(computeGatewayConfigHash(input), computeGatewayConfigHash(input));
});

test("computeGatewayConfigHash stays stable when buildGatewayConfig output varies by origin or api key", () => {
  const configA = buildGatewayConfig(
    "api-key-a",
    "https://app-a.example.com",
    "telegram-token",
    { botToken: "xoxb-test", signingSecret: "slack-secret" },
    "telegram-secret",
  );
  const configB = buildGatewayConfig(
    "api-key-b",
    "https://app-b.example.com",
    "telegram-token",
    { botToken: "xoxb-test", signingSecret: "slack-secret" },
    "telegram-secret",
  );

  assert.notEqual(configA, configB);
  assert.equal(
    computeGatewayConfigHash({
      telegramBotToken: "telegram-token",
      telegramWebhookSecret: "telegram-secret",
      slackCredentials: {
        botToken: "xoxb-test",
        signingSecret: "slack-secret",
      },
    }),
    computeGatewayConfigHash({
      telegramBotToken: "telegram-token",
      telegramWebhookSecret: "telegram-secret",
      slackCredentials: {
        botToken: "xoxb-test",
        signingSecret: "slack-secret",
      },
    }),
  );
});

test("computeGatewayConfigHash changes when telegram bot token changes", () => {
  const baseline = computeGatewayConfigHash({
    telegramBotToken: "telegram-token-a",
  });
  const changed = computeGatewayConfigHash({
    telegramBotToken: "telegram-token-b",
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash changes when telegram webhook secret changes", () => {
  const baseline = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "secret-a",
  });
  const changed = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "secret-b",
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash changes when slack bot token changes", () => {
  const baseline = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-a",
      signingSecret: "slack-secret",
    },
  });
  const changed = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-b",
      signingSecret: "slack-secret",
    },
  });

  assert.notEqual(baseline, changed);
});

test("computeGatewayConfigHash changes when slack signing secret changes and uses the current version", () => {
  const baseline = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "secret-a",
    },
  });
  const changed = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "xoxb-test",
      signingSecret: "secret-b",
    },
  });

  assert.equal(GATEWAY_CONFIG_HASH_VERSION, 1);
  assert.notEqual(baseline, changed);
});
