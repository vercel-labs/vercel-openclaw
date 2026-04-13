import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGatewayConfig,
  buildGatewayRestartScript,
  computeGatewayConfigHash,
  toWhatsAppGatewayConfig,
  GATEWAY_CONFIG_HASH_VERSION,
  buildStartupScript,
  buildFastRestoreScript,
  buildForcePairScript,
  buildWebSearchSkill,
  buildWebSearchScript,
  buildVisionSkill,
  buildVisionScript,
  buildTtsSkill,
  buildTtsScript,
  buildStructuredExtractSkill,
  buildStructuredExtractScript,
  buildEmbeddingsSkill,
  buildEmbeddingsScript,
  buildSemanticSearchSkill,
  buildSemanticSearchScript,
  buildTranscriptionSkill,
  buildTranscriptionScript,
  buildReasoningSkill,
  buildReasoningScript,
  buildCompareSkill,
  buildCompareScript,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
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

test("buildGatewayConfig enables insecure auth by default behind the proxy and disables device auth", () => {
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

      assert.equal(config.gateway.controlUi.allowInsecureAuth, true);
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

test("buildGatewayConfig disables update checks on startup", () => {
  const config = JSON.parse(buildGatewayConfig()) as {
    update?: {
      checkOnStart?: boolean;
    };
  };

  assert.equal(config.update?.checkOnStart, false);
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
  assert.ok(modelIds.includes("whisper-1"));

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

test("buildGatewayConfig includes bypass param in telegram webhookUrl when secret is set", () => {
  const original = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "test-bypass-secret";
    const config = JSON.parse(
      buildGatewayConfig(undefined, "https://app.example.com", "test-telegram-token"),
    ) as {
      channels: { telegram: { webhookUrl?: string } };
    };
    assert.ok(
      config.channels.telegram.webhookUrl?.includes("x-vercel-protection-bypass=test-bypass-secret"),
      "telegram webhookUrl in openclaw.json must include bypass param when secret is configured",
    );
  } finally {
    if (original === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = original;
    }
  }
});

test("buildGatewayConfig omits bypass param from telegram webhookUrl when secret is not set", () => {
  const original = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const config = JSON.parse(
      buildGatewayConfig(undefined, "https://app.example.com", "test-telegram-token"),
    ) as {
      channels: { telegram: { webhookUrl?: string } };
    };
    assert.ok(
      !config.channels.telegram.webhookUrl?.includes("x-vercel-protection-bypass"),
      "telegram webhookUrl must not include bypass param when secret is not configured",
    );
  } finally {
    if (original === undefined) {
      delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    } else {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = original;
    }
  }
});

// ---------------------------------------------------------------------------
// Skill builders — content assertions
// ---------------------------------------------------------------------------

test("buildWebSearchSkill returns valid skill metadata", () => {
  const skill = buildWebSearchSkill();
  assert.ok(skill.includes("name: web-search"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildWebSearchScript references web_search and chat completions", () => {
  const script = buildWebSearchScript();
  assert.ok(script.includes("web_search"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildVisionSkill returns valid skill metadata", () => {
  const skill = buildVisionSkill();
  assert.ok(skill.includes("name: vision"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildVisionScript references image_url and chat completions", () => {
  const script = buildVisionScript();
  assert.ok(script.includes("image_url"));
  assert.ok(script.includes("/v1/chat/completions"));
});

test("buildTtsSkill returns valid skill metadata", () => {
  const skill = buildTtsSkill();
  assert.ok(skill.includes("name: tts"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildTtsScript uses AI Gateway and outputs MEDIA line", () => {
  const script = buildTtsScript();
  assert.ok(script.includes("ai-gateway.vercel.sh/v1/audio/speech"));
  assert.ok(script.includes("MEDIA:"));
});

test("buildStructuredExtractSkill returns valid skill metadata", () => {
  const skill = buildStructuredExtractSkill();
  assert.ok(skill.includes("name: structured-extract"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
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

test("buildGatewayRestartScript does not install interactive shell hooks", () => {
  const script = buildGatewayRestartScript();
  assert.ok(!script.includes(".zshrc"), "restart script must not modify .zshrc");
  assert.ok(!script.includes(".bashrc"), "restart script must not modify .bashrc");
  assert.ok(!script.includes("preexec()"), "restart script must not install zsh preexec hook");
  // The net-learn module (which writes to shell-commands-for-learning.log)
  // IS expected in the restart script — it patches Node.js http/https, not shell hooks.
  assert.ok(script.includes("net-learn.js"), "restart script should write the net-learn module");
});

test("buildGatewayRestartScript kills existing gateway and relaunches it", () => {
  const script = buildGatewayRestartScript();
  assert.ok(script.includes("openclaw") && script.includes("kill"), "restart script should kill existing gateway");
  assert.ok(script.includes("setsid"), "restart script should relaunch via setsid");
  assert.ok(script.includes("gateway --port 3000 --bind loopback"), "restart script should launch the gateway");
});

test("buildStartupScript launches gateway via shell", () => {
  const startup = buildStartupScript();

  assert.ok(startup.includes("setsid"), "startup script should use setsid");
  assert.ok(startup.includes("gateway --port 3000 --bind loopback"), "startup script should launch gateway");
  assert.ok(startup.includes("&"), "startup script should background the gateway");

  // Still clears pairing state and sets up learning hooks
  assert.ok(startup.includes("paired.json"), "startup should clear paired.json");
  assert.ok(startup.includes("shell-commands-for-learning"), "startup should install learning hooks");
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

test("computeGatewayConfigHash is deterministic for identical input", () => {
  const input = {
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
    slackCredentials: {
      botToken: "slack-bot-token",
      signingSecret: "slack-signing-secret",
    },
  };

  assert.equal(computeGatewayConfigHash(input), computeGatewayConfigHash(input));
});

test("computeGatewayConfigHash changes when channel config changes", () => {
  const base = computeGatewayConfigHash({});
  const telegram = computeGatewayConfigHash({
    telegramBotToken: "telegram-token",
    telegramWebhookSecret: "telegram-secret",
  });
  const slack = computeGatewayConfigHash({
    slackCredentials: {
      botToken: "slack-bot-token",
      signingSecret: "slack-signing-secret",
    },
  });

  assert.notEqual(base, telegram);
  assert.notEqual(base, slack);
  assert.notEqual(telegram, slack);
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

// ---------------------------------------------------------------------------
// buildGatewayConfig — WhatsApp gateway-native channel
// ---------------------------------------------------------------------------

test("buildGatewayConfig includes whatsapp policy config when enabled", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+1234567890"],
      groups: ["group-1"],
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.ok(config.channels?.whatsapp, "whatsapp channel should be present");
  assert.equal(config.channels!.whatsapp!.enabled, true);
  assert.equal(config.channels!.whatsapp!.dmPolicy, "open");
  assert.deepEqual(config.channels!.whatsapp!.allowFrom, ["*"]);
  assert.equal(config.channels!.whatsapp!.groupPolicy, "allowlist");
  assert.deepEqual(config.channels!.whatsapp!.groupAllowFrom, ["+1234567890"]);
  assert.deepEqual(config.channels!.whatsapp!.groups, ["group-1"]);
});

test("buildGatewayConfig uses default whatsapp policies when only enabled is set", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.ok(config.channels?.whatsapp);
  assert.equal(config.channels!.whatsapp!.dmPolicy, "pairing");
  assert.deepEqual(config.channels!.whatsapp!.allowFrom, []);
  assert.equal(config.channels!.whatsapp!.groupPolicy, "allowlist");
});

test("buildGatewayConfig omits whatsapp when not enabled", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: false,
    }),
  ) as { channels?: { whatsapp?: unknown } };

  assert.equal(config.channels?.whatsapp, undefined);
});

test("buildGatewayConfig omits whatsapp when config is undefined", () => {
  const config = JSON.parse(
    buildGatewayConfig(),
  ) as { channels?: { whatsapp?: unknown } };

  assert.equal(config.channels?.whatsapp, undefined);
});

test("buildGatewayConfig omits whatsapp groups key when groups is not provided", () => {
  const config = JSON.parse(
    buildGatewayConfig(undefined, undefined, undefined, undefined, undefined, {
      enabled: true,
    }),
  ) as { channels?: { whatsapp?: Record<string, unknown> } };

  assert.equal(
    Object.prototype.hasOwnProperty.call(config.channels!.whatsapp!, "groups"),
    false,
    "groups key should not be present when undefined",
  );
});

test("buildGatewayConfig includes whatsapp alongside telegram and slack", () => {
  const config = JSON.parse(
    buildGatewayConfig(
      "api-key",
      "https://app.example.com",
      "telegram-token",
      { botToken: "xoxb-test", signingSecret: "slack-secret" },
      "telegram-secret",
      { enabled: true, dmPolicy: "pairing" },
    ),
  ) as { channels?: Record<string, unknown> };

  assert.ok(config.channels?.telegram, "telegram should be present");
  assert.ok(config.channels?.slack, "slack should be present");
  assert.ok(config.channels?.whatsapp, "whatsapp should be present");
});

// ---------------------------------------------------------------------------
// computeGatewayConfigHash — WhatsApp
// ---------------------------------------------------------------------------

test("computeGatewayConfigHash changes when whatsapp config is added", () => {
  const baseline = computeGatewayConfigHash({});
  const withWhatsApp = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "open" },
  });

  assert.notEqual(baseline, withWhatsApp);
});

test("computeGatewayConfigHash changes when whatsapp policy changes", () => {
  const a = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "pairing" },
  });
  const b = computeGatewayConfigHash({
    whatsappConfig: { enabled: true, dmPolicy: "open" },
  });

  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// toWhatsAppGatewayConfig helper
// ---------------------------------------------------------------------------

test("toWhatsAppGatewayConfig returns undefined for null input", () => {
  assert.equal(toWhatsAppGatewayConfig(null), undefined);
});

test("toWhatsAppGatewayConfig returns undefined when not enabled", () => {
  assert.equal(
    toWhatsAppGatewayConfig({ enabled: false }),
    undefined,
  );
});

test("toWhatsAppGatewayConfig extracts gateway-relevant fields", () => {
  const result = toWhatsAppGatewayConfig({
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["+1"],
    groups: ["g1"],
  });

  assert.deepEqual(result, {
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "allowlist",
    groupAllowFrom: ["+1"],
    groups: ["g1"],
  });
});

// --- Embeddings skill ---

test("buildEmbeddingsSkill returns valid skill metadata", () => {
  const skill = buildEmbeddingsSkill();
  assert.ok(skill.includes("name: embeddings"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildEmbeddingsScript uses /v1/embeddings", () => {
  const script = buildEmbeddingsScript();
  assert.ok(script.includes("/v1/embeddings"));
  assert.ok(script.includes("text-embedding-3-small"));
});

// --- Semantic Search skill ---

test("buildSemanticSearchSkill returns valid skill metadata", () => {
  const skill = buildSemanticSearchSkill();
  assert.ok(skill.includes("name: semantic-search"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildSemanticSearchScript uses embeddings and cosine similarity", () => {
  const script = buildSemanticSearchScript();
  assert.ok(script.includes("/v1/embeddings"));
  assert.ok(script.includes("cosineSimilarity"));
  assert.ok(script.includes("schemaVersion: 1"));
  assert.ok(script.includes("queryDimensions = dimensions ?? index.dimensions ?? undefined"));
});

// --- Transcription skill ---

test("buildTranscriptionSkill returns valid skill metadata", () => {
  const skill = buildTranscriptionSkill();
  assert.ok(skill.includes("name: transcription"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildTranscriptionScript uses /v1/audio/transcriptions and whisper-1", () => {
  const script = buildTranscriptionScript();
  assert.ok(script.includes("/v1/audio/transcriptions"));
  assert.ok(script.includes("whisper-1"));
  assert.ok(script.includes("FormData"));
});

// --- Reasoning skill ---

test("buildReasoningSkill returns valid skill metadata", () => {
  const skill = buildReasoningSkill();
  assert.ok(skill.includes("name: reasoning"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildReasoningScript uses chat completions and reasoning effort", () => {
  const script = buildReasoningScript();
  assert.ok(script.includes("/v1/chat/completions"));
  assert.ok(script.includes("reasoning"));
  assert.ok(script.includes("effort"));
  assert.ok(script.includes("reasoning_summary"));
  assert.ok(script.includes("reasoning_details"));
  assert.ok(script.includes('"minimal"'));
  assert.ok(script.includes('"xhigh"'));
});

// ---------------------------------------------------------------------------
// Executable runtime regression tests
// ---------------------------------------------------------------------------

async function writeGeneratedFile(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

function runNodeScript(
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("buildEmbeddingsScript rejects non-positive dimensions at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-embeddings-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "embed.mjs",
      buildEmbeddingsScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--text", "hello", "--dimensions", "0"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--dimensions must be a positive integer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic-search index excludes db file on repeated runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-semantic-search-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "search.mjs",
      buildSemanticSearchScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `function fakeEmbedding(value) {
  const text = String(value);
  const sum = [...text].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return [sum, text.length, sum % 97];
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  return new Response(
    JSON.stringify({
      data: inputs.map((input, index) => ({
        index,
        embedding: fakeEmbedding(input),
      })),
      model: body.model,
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const docsDir = join(dir, "docs");
    await mkdir(docsDir, { recursive: true });
    const alphaPath = join(docsDir, "alpha.txt");
    const betaPath = join(docsDir, "beta.txt");
    const dbPath = join(docsDir, ".semantic-index.json");

    await writeFile(alphaPath, "alpha document\n");
    await writeFile(betaPath, "beta document\n");

    for (let i = 0; i < 2; i += 1) {
      const run = runNodeScript(
        [
          "--import",
          preloadPath,
          scriptPath,
          "index",
          "--dir",
          docsDir,
          "--db",
          dbPath,
        ],
        { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);
    }

    const index = JSON.parse(await readFile(dbPath, "utf8")) as {
      chunks: Array<{ path: string }>;
    };
    const indexedPaths = [
      ...new Set(index.chunks.map((chunk) => chunk.path)),
    ].sort();
    assert.deepEqual(indexedPaths, [alphaPath, betaPath].sort());
    assert.ok(
      index.chunks.every((chunk) => chunk.path !== dbPath),
      "semantic-search should never index its own db file",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("semantic-search query rejects dimensions that do not match the existing index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-semantic-query-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "search.mjs",
      buildSemanticSearchScript(),
    );

    const dbPath = join(dir, "index.json");
    await writeFile(
      dbPath,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-03-29T00:00:00.000Z",
        model: "openai/text-embedding-3-small",
        dimensions: 3,
        rootDir: null,
        chunks: [
          {
            id: "doc:0:4",
            path: "/tmp/doc.txt",
            start: 0,
            end: 4,
            text: "test",
            embedding: [1, 0, 0],
          },
        ],
      }) + "\n",
    );

    const run = runNodeScript(
      [
        scriptPath,
        "query",
        "--db",
        dbPath,
        "--query",
        "hello",
        "--dimensions",
        "4",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /--dimensions must match the indexed dimensions \(3\) when querying an existing index/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildTranscriptionScript rejects missing --file at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-transcription-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "transcribe.mjs",
      buildTranscriptionScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildTranscriptionScript rejects invalid --format at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-transcription-fmt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "transcribe.mjs",
      buildTranscriptionScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--file", "dummy.mp3", "--format", "invalid"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--format must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript rejects invalid --reasoning-effort at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--prompt", "test", "--reasoning-effort", "extreme"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--reasoning-effort must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript rejects missing prompt at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-noprompt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Compare models skill ---

test("buildCompareSkill returns valid skill metadata", () => {
  const skill = buildCompareSkill();
  assert.ok(skill.includes("name: compare-models"));
  assert.ok(skill.includes("env: []"), "skill should not require AI_GATEWAY_API_KEY env");
});

test("buildCompareScript uses chat completions and Promise.all", () => {
  const script = buildCompareScript();
  assert.ok(script.includes("/v1/chat/completions"));
  assert.ok(script.includes("Promise.all"));
  assert.ok(script.includes("--models"));
});

test("buildCompareScript rejects missing prompt at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-noprompt-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const result = runNodeScript(
      [scriptPath],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prompt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCompareScript rejects single model at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-onemodel-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const result = runNodeScript(
      [scriptPath, "--prompt", "hello", "--models", "gpt-4o"],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /at least two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildReasoningScript extracts summary from reasoning_details at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-reasoning-summary-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "reason.mjs",
      buildReasoningScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (body.reasoning?.effort !== "xhigh") {
    return new Response("unexpected effort", { status: 400 });
  }
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "Final answer.",
            reasoning_details: [
              {
                type: "reasoning.summary",
                summary: "First analyze the problem.",
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const result = runNodeScript(
      [
        "--import",
        preloadPath,
        scriptPath,
        "--prompt",
        "test",
        "--reasoning-effort",
        "xhigh",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Reasoning:\nFirst analyze the problem\./);
    assert.match(result.stdout, /Final answer\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildCompareScript normalizes common shorthand model ids at runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-compare-normalize-"));
  try {
    const scriptPath = await writeGeneratedFile(
      dir,
      "compare.mjs",
      buildCompareScript(),
    );

    const preloadPath = await writeGeneratedFile(
      dir,
      "mock-fetch.mjs",
      `globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: body.model } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};`,
    );

    const result = runNodeScript(
      [
        "--import",
        preloadPath,
        scriptPath,
        "--prompt",
        "hello",
        "--models",
        "gpt-4o,claude-sonnet-4.6",
      ],
      { cwd: dir, env: { AI_GATEWAY_API_KEY: "test-key" } },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /## openai\/gpt-4o/);
    assert.match(result.stdout, /## anthropic\/claude-sonnet-4.6/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildFastRestoreScript — gateway reset behavior
// ---------------------------------------------------------------------------

test("buildFastRestoreScript polls for process death instead of fixed sleep", () => {
  const script = buildFastRestoreScript();

  // The script should contain the conditional pkill + poll pattern.
  assert.ok(
    script.includes("if pkill -f 'openclaw.gateway'"),
    "expected conditional pkill check",
  );
  assert.ok(
    script.includes("_killed_existing_gateway=1"),
    "expected killed flag set inside if-block",
  );

  // Should poll with pgrep instead of fixed sleep 1
  assert.ok(
    script.includes("pgrep -f 'openclaw.gateway'"),
    "expected pgrep poll loop for process death",
  );
  assert.ok(
    !script.includes("_sleep_ms=1000"),
    "should not have fixed 1000ms sleep duration",
  );

  // Verify pgrep poll is inside the if-block
  const lines = script.split("\n");
  const pkillLine = lines.findIndex((l) =>
    l.includes("if pkill -f 'openclaw.gateway'"),
  );
  const pgrepLine = lines.findIndex(
    (l, i) => i > pkillLine && l.includes("pgrep -f 'openclaw.gateway'"),
  );
  const fiLine = lines.findIndex(
    (l, i) => i > pkillLine && l.trim() === "fi",
  );
  assert.ok(pkillLine >= 0, "pkill line must exist");
  assert.ok(pgrepLine >= 0, "pgrep poll line must exist");
  assert.ok(fiLine >= 0, "fi line must exist");
  assert.ok(
    pgrepLine < fiLine,
    "pgrep poll must be inside the if-block (before fi)",
  );
});

test("buildFastRestoreScript emits fast_restore.gateway_reset log with killed, sleepMs, killMs", () => {
  const script = buildFastRestoreScript();

  assert.ok(
    script.includes("fast_restore.gateway_reset"),
    "expected gateway_reset log event",
  );
  assert.ok(
    script.includes('"killed"'),
    "expected killed field in gateway_reset log",
  );
  assert.ok(
    script.includes('"sleepMs"'),
    "expected sleepMs field in gateway_reset log",
  );
  assert.ok(
    script.includes('"killMs"'),
    "expected killMs field in gateway_reset log",
  );
});

test("buildFastRestoreScript defers post-ready force-pair work to background", () => {
  const script = buildFastRestoreScript();

  assert.ok(
    script.includes('{"event":"fast_restore.post_ready_tasks_complete"'),
    "expected post_ready_tasks_complete log event",
  );
  assert.ok(
    script.includes(`node "${OPENCLAW_FORCE_PAIR_SCRIPT_PATH}" "${OPENCLAW_STATE_DIR}"`),
    "expected deferred force-pair script invocation",
  );
  assert.ok(
    script.includes(") >> /tmp/openclaw.log 2>&1 &"),
    "expected post-ready work to run detached in background",
  );
});

test("buildFastRestoreScript fails fast when @buape/carbon is missing instead of self-healing", () => {
  const script = buildFastRestoreScript();

  // Must NOT contain the old runtime install path
  assert.ok(
    !script.includes("fast_restore.installing_peer_deps"),
    "must not contain installing_peer_deps — runtime self-heal was removed",
  );
  assert.ok(
    !script.includes("npm install @buape/carbon"),
    "must not contain npm install — runtime self-heal was removed",
  );

  // Must contain the fail-fast integrity check
  assert.ok(
    script.includes("fast_restore.missing_dependency"),
    "expected missing_dependency log event",
  );
  assert.ok(
    script.includes('"package":"@buape/carbon"'),
    "expected package field in missing_dependency log",
  );
  assert.ok(
    script.includes('"action":"rebuild_artifact"'),
    "expected action field in missing_dependency log",
  );

  // The check must exit non-zero when the dependency is absent
  const lines = script.split("\n");
  const checkLine = lines.findIndex((l) =>
    l.includes("fast_restore.missing_dependency"),
  );
  const exitLine = lines.findIndex(
    (l, i) => i > checkLine && l.trim() === "exit 1",
  );
  assert.ok(checkLine >= 0, "missing_dependency log line must exist");
  assert.ok(
    exitLine >= 0 && exitLine - checkLine <= 2,
    "exit 1 must immediately follow the missing_dependency log",
  );
});

// ---------------------------------------------------------------------------
// buildFastRestoreScript — stale snapshot invariant (host-scheduler)
// ---------------------------------------------------------------------------

test("buildFastRestoreScript rejects snapshots containing stale skills/host-scheduler", () => {
  const script = buildFastRestoreScript();

  // Must contain the snapshot invariant check
  assert.ok(
    script.includes("fast_restore.stale_snapshot_content"),
    "expected stale_snapshot_content log event",
  );
  assert.ok(
    script.includes('"path":"skills/host-scheduler"'),
    "expected path field in stale_snapshot_content log",
  );
  assert.ok(
    script.includes('"action":"rebuild_snapshot"'),
    "expected action field in stale_snapshot_content log",
  );

  // The check must exit non-zero when the stale directory exists
  const lines = script.split("\n");
  const checkLine = lines.findIndex((l) =>
    l.includes("fast_restore.stale_snapshot_content"),
  );
  const exitLine = lines.findIndex(
    (l, i) => i > checkLine && l.trim() === "exit 1",
  );
  assert.ok(checkLine >= 0, "stale_snapshot_content log line must exist");
  assert.ok(
    exitLine >= 0 && exitLine - checkLine <= 2,
    "exit 1 must immediately follow the stale_snapshot_content log",
  );
});

test("buildFastRestoreScript does not contain rm -rf of skills/host-scheduler", () => {
  const script = buildFastRestoreScript();

  assert.ok(
    !script.includes("rm -rf") || !script.includes("skills/host-scheduler"),
    "must not silently delete skills/host-scheduler — stale snapshots should fail, not be repaired",
  );

  // More precise: no rm command targeting host-scheduler at all
  const lines = script.split("\n");
  const rmLine = lines.find(
    (l) => l.includes("rm ") && l.includes("host-scheduler"),
  );
  assert.equal(
    rmLine,
    undefined,
    "must not contain any rm command targeting host-scheduler",
  );
});

// ---------------------------------------------------------------------------
// buildForcePairScript — corrupt state detection
// ---------------------------------------------------------------------------

async function runForcePairScript(stateDir: string) {
  const script = buildForcePairScript();
  const scriptPath = join(stateDir, ".force-pair-test.mjs");
  await writeFile(scriptPath, script);
  const result = spawnSync(
    process.execPath,
    [scriptPath, stateDir],
    { encoding: "utf8", timeout: 10_000 },
  );
  await rm(scriptPath, { force: true });
  return result;
}

test("buildForcePairScript creates fresh identity when device.json is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-missing-"));
  try {
    const result = await runForcePairScript(dir);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const identity = JSON.parse(await readFile(join(dir, "identity", "device.json"), "utf8"));
    assert.equal(typeof identity.publicKeyPem, "string");
    assert.equal(typeof identity.privateKeyPem, "string");
    const paired = JSON.parse(await readFile(join(dir, "devices", "paired.json"), "utf8"));
    assert.equal(typeof paired, "object");
    assert.ok(!Array.isArray(paired));
    assert.ok(Object.keys(paired).length === 1, "expected exactly one paired device");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildForcePairScript exits non-zero on malformed device.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-bad-device-"));
  try {
    await mkdir(join(dir, "identity"), { recursive: true });
    await writeFile(join(dir, "identity", "device.json"), "NOT VALID JSON{{{");

    const result = await runForcePairScript(dir);

    assert.notEqual(result.status, 0, "expected non-zero exit for malformed device.json");

    // Must emit structured corrupt_state event
    assert.ok(
      result.stderr.includes("force_pair.corrupt_state"),
      `expected force_pair.corrupt_state in stderr, got: ${result.stderr}`,
    );
    const logLine = result.stderr
      .split("\n")
      .find((l) => l.includes("force_pair.corrupt_state"));
    assert.ok(logLine, "expected structured log line");
    const parsed = JSON.parse(logLine!);
    assert.equal(parsed.reason, "device_json_invalid");
    assert.ok(parsed.filePath.endsWith("device.json"));
    assert.ok(parsed.backupPath?.includes(".corrupt-"), "expected timestamped backup path");

    // Original corrupted file must still exist (not silently replaced)
    const original = await readFile(join(dir, "identity", "device.json"), "utf8");
    assert.equal(original, "NOT VALID JSON{{{", "corrupted file must not be overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildForcePairScript exits non-zero on parseable device.json with invalid public key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-bad-device-key-"));
  try {
    await mkdir(join(dir, "identity"), { recursive: true });
    await writeFile(
      join(dir, "identity", "device.json"),
      `${JSON.stringify(
        {
          publicKeyPem: "not-a-pem",
          privateKeyPem: "still-not-a-real-key",
          createdAtMs: Date.now(),
        },
        null,
        2,
      )}\n`,
    );

    const result = await runForcePairScript(dir);

    assert.notEqual(
      result.status,
      0,
      "expected non-zero exit for invalid device public key",
    );
    assert.ok(
      result.stderr.includes("force_pair.corrupt_state"),
      `expected force_pair.corrupt_state in stderr, got: ${result.stderr}`,
    );
    const logLine = result.stderr
      .split("\n")
      .find((l) => l.includes("force_pair.corrupt_state"));
    assert.ok(logLine, "expected structured log line");
    const parsed = JSON.parse(logLine!);
    assert.equal(parsed.reason, "device_json_key_invalid");
    assert.ok(parsed.filePath.endsWith("device.json"));
    assert.ok(parsed.backupPath?.includes(".corrupt-"), "expected timestamped backup path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildForcePairScript exits non-zero on malformed paired.json (array instead of object)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-bad-paired-"));
  try {
    // Create a valid identity so the script gets past device.json
    await mkdir(join(dir, "identity"), { recursive: true });
    await mkdir(join(dir, "devices"), { recursive: true });

    // Pre-create a valid device identity by running the script once with no files
    const bootstrapDir = await mkdtemp(join(tmpdir(), "fp-bootstrap-"));
    const bootstrap = await runForcePairScript(bootstrapDir);
    assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.stderr}`);

    // Copy the valid identity into our test dir
    const validIdentity = await readFile(join(bootstrapDir, "identity", "device.json"), "utf8");
    await writeFile(join(dir, "identity", "device.json"), validIdentity);
    await rm(bootstrapDir, { recursive: true, force: true });

    // Write a malformed paired.json (array instead of object)
    await writeFile(join(dir, "devices", "paired.json"), "[]");

    const result = await runForcePairScript(dir);

    assert.notEqual(result.status, 0, "expected non-zero exit for malformed paired.json");

    // Must emit structured corrupt_state event
    assert.ok(
      result.stderr.includes("force_pair.corrupt_state"),
      `expected force_pair.corrupt_state in stderr, got: ${result.stderr}`,
    );
    const logLine = result.stderr
      .split("\n")
      .find((l) => l.includes("force_pair.corrupt_state"));
    const parsed = JSON.parse(logLine!);
    assert.equal(parsed.reason, "paired_json_shape_invalid");
    assert.ok(parsed.filePath.endsWith("paired.json"));
    assert.ok(parsed.backupPath?.includes(".corrupt-"), "expected timestamped backup path");

    // Original corrupted file must still exist
    const original = await readFile(join(dir, "devices", "paired.json"), "utf8");
    assert.equal(original, "[]", "corrupted paired.json must not be overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildForcePairScript purges stale entries that lack role/scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fp-purge-stale-"));
  try {
    // Pre-seed paired.json with a stale entry (no role/scopes — pre-9a142fc format)
    await mkdir(join(dir, "devices"), { recursive: true });
    await writeFile(
      join(dir, "devices", "paired.json"),
      JSON.stringify({
        "stale-device-id": {
          deviceId: "stale-device-id",
          publicKey: "staleKey",
          approvedAtMs: 1000000,
        },
      }),
    );

    const result = await runForcePairScript(dir);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);

    const paired = JSON.parse(await readFile(join(dir, "devices", "paired.json"), "utf8"));
    const entries = Object.values(paired) as Array<{ role?: string }>;
    assert.equal(entries.length, 1, "should have exactly one entry after purge");
    assert.equal(entries[0]!.role, "operator", "surviving entry should have operator role");
    assert.ok(
      !("stale-device-id" in paired),
      "stale entry without role should be purged",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
