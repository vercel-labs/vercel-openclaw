import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBootstrapFiles,
  buildDynamicRestoreFiles,
  buildRestoreAssetManifest,
  buildRestoreRuntimeEnv,
  buildStaticRestoreFiles,
  buildWorkerSandboxRestoreFiles,
  OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
} from "@/server/openclaw/restore-assets";
import {
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_FORCE_PAIR_SCRIPT_PATH,
  OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH,
  OPENCLAW_STARTUP_SCRIPT_PATH,
  OPENCLAW_STATE_DIR,
  OPENCLAW_EMBEDDINGS_SKILL_PATH,
  OPENCLAW_EMBEDDINGS_SCRIPT_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH,
  OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH,
  OPENCLAW_TRANSCRIPTION_SKILL_PATH,
  OPENCLAW_TRANSCRIPTION_SCRIPT_PATH,
  OPENCLAW_REASONING_SKILL_PATH,
  OPENCLAW_REASONING_SCRIPT_PATH,
  OPENCLAW_COMPARE_SKILL_PATH,
  OPENCLAW_COMPARE_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH,
  OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH,
} from "@/server/openclaw/config";

// --- buildRestoreAssetManifest ---

test("buildRestoreAssetManifest returns stable sha256 across calls", () => {
  const first = buildRestoreAssetManifest();
  const second = buildRestoreAssetManifest();

  assert.deepStrictEqual(first, second);
  assert.equal(first.version, 1);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
});

test("buildRestoreAssetManifest staticPaths matches buildStaticRestoreFiles paths", () => {
  const manifest = buildRestoreAssetManifest();
  const staticFiles = buildStaticRestoreFiles();

  assert.deepStrictEqual(
    manifest.staticPaths,
    staticFiles.map((f) => f.path),
  );
});

// --- buildStaticRestoreFiles ---

test("static restore files include startup, force-pair, and restart scripts", () => {
  const paths = buildStaticRestoreFiles().map((f) => f.path);

  assert.ok(paths.includes(OPENCLAW_STARTUP_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_FORCE_PAIR_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_EMBEDDINGS_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_EMBEDDINGS_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_TRANSCRIPTION_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_TRANSCRIPTION_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_REASONING_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_REASONING_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_COMPARE_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_COMPARE_SCRIPT_PATH));
  assert.ok(paths.includes(OPENCLAW_WORKER_SANDBOX_SKILL_PATH));
  assert.ok(paths.includes(OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH));
});

test("static restore files produce non-empty buffers", () => {
  for (const file of buildStaticRestoreFiles()) {
    assert.ok(Buffer.isBuffer(file.content), `${file.path} content is a Buffer`);
    assert.ok(file.content.length > 0, `${file.path} content is non-empty`);
  }
});

// --- buildDynamicRestoreFiles ---

test("dynamic restore files only contain openclaw.json with the provided origin", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://example.test",
    apiKey: "token-123",
  });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, OPENCLAW_CONFIG_PATH);

  const content = files[0]!.content.toString("utf8");
  assert.ok(content.includes("https://example.test"));
});

test("dynamic restore files work without apiKey", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://no-key.test",
  });

  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, OPENCLAW_CONFIG_PATH);
});

test("dynamic restore files include telegram webhookSecret in openclaw config", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://telegram.test",
    telegramBotToken: "telegram-bot-token",
    telegramWebhookSecret: "telegram-webhook-secret",
  });

  const configFile = files.find((file) => file.path === OPENCLAW_CONFIG_PATH);
  assert.ok(configFile, "Expected dynamic restore files to include openclaw config");

  const config = JSON.parse(configFile.content.toString("utf8")) as {
    channels?: {
      telegram?: {
        webhookSecret?: string;
      };
    };
  };

  assert.equal(
    config.channels?.telegram?.webhookSecret,
    "telegram-webhook-secret",
  );
});

test("dynamic restore files include whatsapp policy config in openclaw config", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://whatsapp.test",
    whatsappConfig: {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
  });

  const configFile = files.find((file) => file.path === OPENCLAW_CONFIG_PATH);
  assert.ok(configFile, "Expected dynamic restore files to include openclaw config");

  const config = JSON.parse(configFile.content.toString("utf8")) as {
    channels?: {
      whatsapp?: {
        enabled?: boolean;
        dmPolicy?: string;
      };
    };
  };

  assert.equal(config.channels?.whatsapp?.enabled, true);
  assert.equal(config.channels?.whatsapp?.dmPolicy, "open");
});

test("dynamic restore files omit whatsapp when config is undefined", () => {
  const files = buildDynamicRestoreFiles({
    proxyOrigin: "https://no-whatsapp.test",
  });

  const configFile = files.find((file) => file.path === OPENCLAW_CONFIG_PATH);
  assert.ok(configFile);

  const config = JSON.parse(configFile.content.toString("utf8")) as {
    channels?: { whatsapp?: unknown };
  };

  assert.equal(config.channels?.whatsapp, undefined);
});

// --- buildWorkerSandboxRestoreFiles ---

test("worker sandbox restore files contain exactly the goal-critical pair", () => {
  const files = buildWorkerSandboxRestoreFiles();
  assert.deepStrictEqual(
    files.map((file) => file.path),
    [
      OPENCLAW_WORKER_SANDBOX_SKILL_PATH,
      OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH,
      OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH,
      OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH,
    ],
  );
  for (const file of files) {
    assert.ok(file.content.length > 0, `${file.path} should be non-empty`);
  }
});

// --- buildRestoreRuntimeEnv ---

test("buildRestoreRuntimeEnv does not include config JSON in env (exceeds 4096 byte limit)", () => {
  const env = buildRestoreRuntimeEnv({
    gatewayToken: "gw-token",
  });

  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "gw-token");
  assert.equal(env.OPENCLAW_CONFIG_JSON_B64, undefined,
    "Config must not be passed via env — sandbox API enforces 4096 byte env limit");
  assert.equal(env.AI_GATEWAY_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

test("buildRestoreRuntimeEnv includes AI gateway env when apiKey is present", () => {
  const env = buildRestoreRuntimeEnv({
    gatewayToken: "gw-token",
    apiKey: "test-ai-key",
  });

  assert.equal(env.AI_GATEWAY_API_KEY, "test-ai-key");
  assert.equal(env.OPENAI_API_KEY, "test-ai-key");
  assert.equal(env.OPENAI_BASE_URL, "https://ai-gateway.vercel.sh/v1");
});

// --- manifest path ---

test("manifest path is under the openclaw state directory", () => {
  assert.ok(
    OPENCLAW_RESTORE_ASSET_MANIFEST_PATH.startsWith(OPENCLAW_STATE_DIR),
    `Expected ${OPENCLAW_RESTORE_ASSET_MANIFEST_PATH} to start with ${OPENCLAW_STATE_DIR}`,
  );
  assert.ok(OPENCLAW_RESTORE_ASSET_MANIFEST_PATH.endsWith(".json"));
});

// --- buildBootstrapFiles ---

test("buildBootstrapFiles includes all static, dynamic, token, key, and manifest files", () => {
  const files = buildBootstrapFiles({
    gatewayToken: "tok-test",
    apiKey: "ak-test",
    proxyOrigin: "https://bootstrap.test",
  });

  const paths = files.map((f) => f.path);

  // Dynamic: openclaw.json
  assert.ok(paths.includes(OPENCLAW_CONFIG_PATH), "should include openclaw.json");
  // Static: startup, force-pair, restart scripts
  assert.ok(paths.includes(OPENCLAW_STARTUP_SCRIPT_PATH), "should include startup script");
  assert.ok(paths.includes(OPENCLAW_FORCE_PAIR_SCRIPT_PATH), "should include force-pair script");
  assert.ok(paths.includes(OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH), "should include restart script");
  // Token files
  const tokenFile = files.find((f) => f.path.endsWith(".gateway-token"));
  assert.ok(tokenFile, "should include gateway token file");
  assert.equal(tokenFile!.content.toString(), "tok-test");
  const keyFile = files.find((f) => f.path.endsWith(".ai-gateway-api-key"));
  assert.ok(keyFile, "should include AI gateway key file");
  assert.equal(keyFile!.content.toString(), "ak-test");
  // Manifest
  assert.ok(paths.includes(OPENCLAW_RESTORE_ASSET_MANIFEST_PATH), "should include manifest");
});

test("buildBootstrapFiles writes empty AI key when apiKey is omitted", () => {
  const files = buildBootstrapFiles({
    gatewayToken: "tok",
    proxyOrigin: "https://no-key.test",
  });
  const keyFile = files.find((f) => f.path.endsWith(".ai-gateway-api-key"));
  assert.ok(keyFile);
  assert.equal(keyFile!.content.toString(), "");
});

test("buildBootstrapFiles includes telegram bot token when provided", () => {
  const files = buildBootstrapFiles({
    gatewayToken: "tok",
    proxyOrigin: "https://tg.test",
    telegramBotToken: "tg-bot-token",
    telegramWebhookSecret: "tg-secret",
  });
  const paths = files.map((f) => f.path);
  assert.ok(
    paths.some((p) => p.includes("telegram-bot-token")),
    "should include telegram bot token file",
  );
});

test("buildBootstrapFiles is a superset of static + dynamic restore files", () => {
  const opts = {
    gatewayToken: "tok",
    apiKey: "ak",
    proxyOrigin: "https://superset.test",
  };
  const bootstrapPaths = new Set(buildBootstrapFiles(opts).map((f) => f.path));
  const staticPaths = buildStaticRestoreFiles().map((f) => f.path);
  const dynamicPaths = buildDynamicRestoreFiles({
    proxyOrigin: opts.proxyOrigin,
    apiKey: opts.apiKey,
  }).map((f) => f.path);

  for (const p of staticPaths) {
    assert.ok(bootstrapPaths.has(p), `bootstrap missing static path: ${p}`);
  }
  for (const p of dynamicPaths) {
    assert.ok(bootstrapPaths.has(p), `bootstrap missing dynamic path: ${p}`);
  }
});

test("buildBootstrapFiles manifest matches buildRestoreAssetManifest", () => {
  const files = buildBootstrapFiles({
    gatewayToken: "tok",
    proxyOrigin: "https://manifest.test",
  });
  const manifestFile = files.find(
    (f) => f.path === OPENCLAW_RESTORE_ASSET_MANIFEST_PATH,
  );
  assert.ok(manifestFile, "manifest file should be present");
  const embedded = JSON.parse(manifestFile!.content.toString());
  const standalone = buildRestoreAssetManifest();
  assert.deepStrictEqual(embedded, standalone);
});
