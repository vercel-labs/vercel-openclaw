import { createHash } from "node:crypto";
import { getProtectionBypassSecret } from "@/server/public-url";

const OPENCLAW_PORT = 3000;

export const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
export const BUN_INSTALL_DIR = "/home/vercel-sandbox/.bun";
export const BUN_BIN = `${BUN_INSTALL_DIR}/bin/bun`;
export const BUN_VERSION = "1.3.11";
// Direct binary download URL — avoids executing a remote installer script.
// Recompute hash: curl -fsSL <URL> | sha256sum
export const BUN_DOWNLOAD_URL = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`;
export const BUN_DOWNLOAD_SHA256 = "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed";
export const OPENCLAW_STATE_DIR = "/home/vercel-sandbox/.openclaw";
export const OPENCLAW_CONFIG_PATH = `${OPENCLAW_STATE_DIR}/openclaw.json`;
export const OPENCLAW_GATEWAY_TOKEN_PATH = `${OPENCLAW_STATE_DIR}/.gateway-token`;
export const OPENCLAW_AI_GATEWAY_API_KEY_PATH = `${OPENCLAW_STATE_DIR}/.ai-gateway-api-key`;

export const OPENCLAW_FORCE_PAIR_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/.force-pair.mjs`;
export const OPENCLAW_NET_LEARN_PATH = "/tmp/net-learn.js";
export const OPENCLAW_TELEGRAM_BOT_TOKEN_PATH = `${OPENCLAW_STATE_DIR}/.telegram-bot-token`;
export const OPENCLAW_TELEGRAM_WEBHOOK_PORT = 8787;
export const OPENCLAW_TELEGRAM_WEBHOOK_HOST = "127.0.0.1";
export const OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH = "/telegram-webhook";
export const TELEGRAM_PUBLIC_WEBHOOK_PATH = "/api/channels/telegram/webhook";
export const OPENCLAW_IMAGE_GEN_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/openai-image-gen/SKILL.md`;
export const OPENCLAW_IMAGE_GEN_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/openai-image-gen/scripts/gen.mjs`;
export const OPENCLAW_WEB_SEARCH_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/web-search/SKILL.md`;
export const OPENCLAW_WEB_SEARCH_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/web-search/scripts/search.mjs`;
export const OPENCLAW_VISION_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/vision/SKILL.md`;
export const OPENCLAW_VISION_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/vision/scripts/analyze.mjs`;
export const OPENCLAW_TTS_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/tts/SKILL.md`;
export const OPENCLAW_TTS_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/tts/scripts/speak.mjs`;
export const OPENCLAW_STRUCTURED_EXTRACT_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/structured-extract/SKILL.md`;
export const OPENCLAW_STRUCTURED_EXTRACT_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/structured-extract/scripts/extract.mjs`;
export const OPENCLAW_EMBEDDINGS_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/embeddings/SKILL.md`;
export const OPENCLAW_EMBEDDINGS_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/embeddings/scripts/embed.mjs`;
export const OPENCLAW_SEMANTIC_SEARCH_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/semantic-search/SKILL.md`;
export const OPENCLAW_SEMANTIC_SEARCH_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/semantic-search/scripts/search.mjs`;
export const OPENCLAW_TRANSCRIPTION_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/transcription/SKILL.md`;
export const OPENCLAW_TRANSCRIPTION_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/transcription/scripts/transcribe.mjs`;
export const OPENCLAW_REASONING_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/reasoning/SKILL.md`;
export const OPENCLAW_REASONING_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/reasoning/scripts/reason.mjs`;
export const OPENCLAW_COMPARE_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/compare-models/SKILL.md`;
export const OPENCLAW_COMPARE_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/compare-models/scripts/compare.mjs`;
export const OPENCLAW_WORKER_SANDBOX_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/worker-sandbox/SKILL.md`;
export const OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/worker-sandbox/scripts/execute.mjs`;
export const OPENCLAW_WORKER_SANDBOX_BATCH_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/worker-sandbox-batch/SKILL.md`;
export const OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/worker-sandbox-batch/scripts/execute-batch.mjs`;

// The built-in skill shipped with the openclaw npm package uses a Python
// gen.py script that requires a direct sk-* OPENAI_API_KEY.  We overwrite
// it so that even if OpenClaw loads the built-in before the user skills
// dir, it picks up our AI-Gateway-compatible version.
const OPENCLAW_PKG_DIR = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
export const OPENCLAW_BUILTIN_IMAGE_GEN_SKILL_PATH = `${OPENCLAW_PKG_DIR}/skills/openai-image-gen/SKILL.md`;
export const OPENCLAW_BUILTIN_IMAGE_GEN_SCRIPT_PATH = `${OPENCLAW_PKG_DIR}/skills/openai-image-gen/scripts/gen.mjs`;
export const OPENCLAW_LOG_FILE = "/tmp/openclaw.log";
export const OPENCLAW_STARTUP_SCRIPT_PATH = "/vercel/sandbox/.on-restore.sh";
export const OPENCLAW_FAST_RESTORE_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/.fast-restore.sh`;
export const OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/.restart-gateway.sh`;

/**
 * HTTP header required by OpenClaw 2026.3.28+ to grant operator scopes
 * on gateway HTTP API endpoints (e.g. /v1/chat/completions).
 * The gateway reads scopes from this request header, not from device-auth.json.
 */
export const OPENCLAW_SCOPES_HEADER = "x-openclaw-scopes";
export const OPENCLAW_OPERATOR_SCOPES = "operator.admin,operator.read,operator.write,operator.approvals,operator.pairing";

function readBooleanEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  throw new Error(
    `${name} must be one of: true, false, 1, 0, yes, no, on, off.`,
  );
}

// ---------------------------------------------------------------------------
// Shared gateway env + launch shell fragments
// ---------------------------------------------------------------------------

const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * Shell fragment that ensures OPENCLAW_GATEWAY_PORT is in the shell profile
 * so CLI tools (openclaw cron list, etc.) and agent-spawned tool processes
 * can find the gateway.  Without this, they default to port 18789.
 */
function buildGatewayPortProfileShell(): string {
  return [
    '_home="${HOME:-/home/vercel-sandbox}"',
    `if ! grep -q 'OPENCLAW_GATEWAY_PORT' "$_home/.zshrc" 2>/dev/null; then`,
    `  echo 'export OPENCLAW_GATEWAY_PORT=${OPENCLAW_PORT}' >> "$_home/.zshrc" 2>/dev/null || true`,
    "fi",
    `if ! grep -q 'OPENCLAW_GATEWAY_PORT' "$_home/.bashrc" 2>/dev/null; then`,
    `  echo 'export OPENCLAW_GATEWAY_PORT=${OPENCLAW_PORT}' >> "$_home/.bashrc" 2>/dev/null || true`,
    "fi",
  ].join("\n");
}

/**
 * Shell fragment that reads the gateway token from disk and exports the
 * variables needed by the openclaw gateway.  The AI Gateway API key is
 * also injected via network policy header transform at the firewall layer
 * (defense-in-depth), but OpenClaw needs the env vars to populate its
 * internal auth store (auth-profiles.json) at startup.
 * Exits non-zero when the gateway token is missing or empty.
 */
function buildGatewayEnvShell(): string {
  return [
    `gateway_token="$(cat "${OPENCLAW_GATEWAY_TOKEN_PATH}" 2>/dev/null || true)"`,
    'if [ -z "$gateway_token" ]; then',
    '  echo \'{"event":"gateway_env.error","reason":"empty_gateway_token"}\' >&2',
    "  exit 1",
    "fi",
    // AI_GATEWAY_API_KEY: always read from disk file (written fresh during
    // bootstrap/restore). The baked-in env var is stale on resume.
    `AI_GATEWAY_API_KEY="$(cat "${OPENCLAW_AI_GATEWAY_API_KEY_PATH}" 2>/dev/null || true)"`,
    'if [ -n "$AI_GATEWAY_API_KEY" ]; then',
    '  export AI_GATEWAY_API_KEY="$AI_GATEWAY_API_KEY"',
    '  export OPENAI_API_KEY="$AI_GATEWAY_API_KEY"',
    "fi",
    `export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}"`,
    `export OPENCLAW_GATEWAY_PORT="${OPENCLAW_PORT}"`,
    'export OPENCLAW_GATEWAY_TOKEN="$gateway_token"',
    `export OPENAI_BASE_URL="${AI_GATEWAY_BASE_URL}"`,
    `export NODE_OPTIONS="\${NODE_OPTIONS:-} --require=${OPENCLAW_NET_LEARN_PATH}"`,
  ].join("\n");
}

/**
 * Shell fragment that writes the Node.js network-learning module to disk.
 * This module monkey-patches http.request/https.request so outbound hostnames
 * are logged to the firewall learning log — covering agent tool calls that
 * bypass interactive shell hooks (preexec/trap).
 */
function buildNetLearnWriteShell(): string {
  // The module is written as a heredoc so it's always fresh on each boot.
  // It appends `fetch https://<host>/` lines to the same log file that
  // the shell hooks use, so the existing ingestion pipeline picks them up.
  return `cat > ${OPENCLAW_NET_LEARN_PATH} <<'NETLEARNEOF'
"use strict";
const fs = require("fs");
const https = require("https");
const http = require("http");
const LOG = "/tmp/shell-commands-for-learning.log";
function logHost(host) {
  if (host && !host.startsWith("127.") && host !== "localhost") {
    fs.appendFile(LOG, "fetch https://" + host + "/\\n", function () {});
  }
}
function patchMod(mod) {
  const orig = mod.request;
  mod.request = function patchedRequest(opts) {
    try {
      const host = typeof opts === "string"
        ? new URL(opts).hostname
        : (opts && (opts.hostname || opts.host)) || null;
      logHost(host);
    } catch (_) { /* never break the caller */ }
    return orig.apply(this, arguments);
  };
}
patchMod(http);
patchMod(https);
if (typeof globalThis.fetch === "function") {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input) {
    try {
      const url = typeof input === "string" ? input
        : (input && input.url) ? input.url : null;
      if (url) logHost(new URL(url).hostname);
    } catch (_) { /* never break the caller */ }
    return origFetch.apply(this, arguments);
  };
}
NETLEARNEOF`;
}

/** Shell fragment that kills any existing gateway and starts a fresh one.
 *  Uses the shell variables exported by buildGatewayEnvShell() so the
 *  conditional API-key logic is honoured.
 *
 *  Kill uses ps/grep/kill instead of pkill because pkill returns exit 255
 *  on the v2 sandbox API, which breaks scripts under set -euo pipefail
 *  even with `|| true`. */
function buildGatewayKillShell(): string {
  return [
    '_gw_pids="$(ps aux | grep \'[o]penclaw.gateway\' | awk \'{print $2}\' || true)"',
    'if [ -n "$_gw_pids" ]; then kill $_gw_pids 2>/dev/null; sleep 1; fi',
    'true',
  ].join("\n");
}

function buildGatewayLaunchShell(): string {
  return `setsid ${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT} --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &`;
}

/**
 * Lightweight script that restarts the gateway without touching pairing state
 * or shell hooks.  Used by token refresh to avoid the side effects of the
 * full startup script.
 */
export function buildGatewayRestartScript(): string {
  return `#!/bin/bash
set -euo pipefail
${buildNetLearnWriteShell()}
${buildGatewayEnvShell()}
${buildGatewayKillShell()}
${buildGatewayLaunchShell()}
`;
}

export type WhatsAppGatewayConfig = {
  enabled: boolean;
  pluginSpec?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  groups?: string[];
};

/**
 * Extract gateway-relevant fields from a WhatsAppChannelConfig.
 * Returns undefined when the config is null or not enabled,
 * so callers can pass the result directly to buildGatewayConfig / hash helpers.
 */
export function toWhatsAppGatewayConfig(
  config: {
    enabled: boolean;
    pluginSpec?: string;
    dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
    allowFrom?: string[];
    groupPolicy?: "open" | "allowlist" | "disabled";
    groupAllowFrom?: string[];
    groups?: string[];
  } | null | undefined,
): WhatsAppGatewayConfig | undefined {
  if (!config?.enabled) return undefined;
  return {
    enabled: true,
    ...(config.pluginSpec ? { pluginSpec: config.pluginSpec } : {}),
    dmPolicy: config.dmPolicy,
    allowFrom: config.allowFrom,
    groupPolicy: config.groupPolicy,
    groupAllowFrom: config.groupAllowFrom,
    groups: config.groups,
  };
}

export function buildGatewayConfig(
  apiKey?: string,
  proxyOrigin?: string,
  telegramBotToken?: string,
  slackCredentials?: { botToken: string; signingSecret: string },
  telegramWebhookSecret?: string,
  whatsappConfig?: WhatsAppGatewayConfig,
): string {
  const controlUi: Record<string, unknown> = {
    // The proxy enforces auth before any request reaches the sandbox gateway,
    // so the control UI can trust the proxied origin and skip its own login gate.
    allowInsecureAuth: readBooleanEnv("OPENCLAW_ALLOW_INSECURE_AUTH", true),
    // Device auth is always disabled in the proxied setup because the
    // server-side force-pair identity can never match the browser's
    // client-generated identity.  The proxy enforces auth before any
    // gateway traffic reaches the sandbox.
    dangerouslyDisableDeviceAuth: true,
  };
  if (proxyOrigin) {
    controlUi.allowedOrigins = [proxyOrigin];
  }

  const config: Record<string, unknown> = {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
      },
      trustedProxies: ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
      controlUi,
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
      },
    },
  };

  config.agents = {
    defaults: {
      model: {
        primary: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
        fallbacks: [
          "vercel-ai-gateway/openai/gpt-5.3-chat",
          "vercel-ai-gateway/anthropic/claude-haiku-4.5",
          "vercel-ai-gateway/openai/gpt-5.2",
          "vercel-ai-gateway/google/gemini-2.5-flash",
        ],
      },
      models: {
        // Anthropic
        "vercel-ai-gateway/anthropic/claude-opus-4.6": { alias: "Claude Opus 4.6" },
        "vercel-ai-gateway/anthropic/claude-sonnet-4.6": { alias: "Claude Sonnet 4.6" },
        "vercel-ai-gateway/anthropic/claude-haiku-4.5": { alias: "Claude Haiku 4.5" },
        // OpenAI
        "vercel-ai-gateway/openai/gpt-5.3-chat": { alias: "GPT-5.3 Chat" },
        "vercel-ai-gateway/openai/gpt-5.2": { alias: "GPT-5.2" },
        "vercel-ai-gateway/openai/gpt-5-mini": { alias: "GPT-5 Mini" },
        "vercel-ai-gateway/openai/o3": { alias: "o3" },
        "vercel-ai-gateway/openai/o4-mini": { alias: "o4-mini" },
        // Google
        "vercel-ai-gateway/google/gemini-2.5-pro": { alias: "Gemini 2.5 Pro" },
        "vercel-ai-gateway/google/gemini-2.5-flash": { alias: "Gemini 2.5 Flash" },
        "vercel-ai-gateway/google/gemini-3-flash": { alias: "Gemini 3 Flash" },
        "vercel-ai-gateway/google/gemini-3.1-flash-image-preview": { alias: "Gemini 3.1 Flash Image" },
        // DeepSeek
        "vercel-ai-gateway/deepseek/deepseek-v3.2": { alias: "DeepSeek V3.2" },
        "vercel-ai-gateway/deepseek/deepseek-v3.2-thinking": { alias: "DeepSeek V3.2 Thinking" },
        // xAI
        "vercel-ai-gateway/xai/grok-4": { alias: "Grok 4" },
        // Mistral
        "vercel-ai-gateway/mistral/mistral-large-3": { alias: "Mistral Large 3" },
        "vercel-ai-gateway/mistral/devstral-2": { alias: "Devstral 2" },
      },
    },
  };
  config.models = {
    mode: "merge",
    providers: {
      openai: {
        baseUrl: AI_GATEWAY_BASE_URL,
        apiKey: "sk-placeholder",
        api: "openai-completions",
        models: [
          { id: "gpt-image-1", name: "GPT Image 1" },
          { id: "dall-e-3", name: "DALL-E 3" },
          { id: "gpt-4o", name: "GPT-4o", input: ["text", "image"] },
          { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
          { id: "text-embedding-3-small", name: "Text Embedding 3 Small" },
          { id: "text-embedding-3-large", name: "Text Embedding 3 Large" },
          { id: "whisper-1", name: "Whisper" },
        ],
      },
    },
  };
  // Grant owner-level tool access (cron, gateway, nodes) to channel
  // senders.  Without this, OpenClaw's native handlers strip owner-only
  // tools from non-admin senders.  The proxy already enforces auth
  // before traffic reaches the sandbox, so elevated access defaults to
  // all senders ("*").  Override with OPENCLAW_OWNER_ALLOW_FROM to
  // restrict to specific Telegram chat IDs or Slack user IDs.
  const ownerAllowFrom = process.env.OPENCLAW_OWNER_ALLOW_FROM;
  config.commands = {
    ownerAllowFrom: ownerAllowFrom
      ? ownerAllowFrom.split(",").map((s) => s.trim()).filter(Boolean)
      : ["*"],
  };

  config.tools = {
    // Use "full" profile so all built-in tools are available, including
    // group:automation (cron, gateway).  The default "coding" profile
    // excludes cron, which prevents the agent from creating scheduled jobs.
    profile: "full",
    media: {
      image: {
        enabled: true,
        models: [
          { provider: "vercel-ai-gateway", model: "anthropic/claude-sonnet-4.6" },
          { provider: "vercel-ai-gateway", model: "openai/gpt-4o" },
        ],
      },
      video: {
        enabled: true,
        models: [{ provider: "vercel-ai-gateway", model: "google/gemini-3-flash" }],
      },
      audio: { enabled: true },
    },
  };

  // Telegram webhook delivery remains app-owned at the public route, but
  // OpenClaw still needs its native Telegram config so boot-time setWebhook
  // registers the app URL instead of the sandbox-local listener.
  if (telegramBotToken) {
    const channels = (config.channels as Record<string, unknown>) ?? {};
    const origin = proxyOrigin?.replace(/\/+$/, "");
    const telegramConfig: Record<string, unknown> = {
      enabled: true,
      botToken: telegramBotToken,
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: ["*"],
      webhookPort: OPENCLAW_TELEGRAM_WEBHOOK_PORT,
      webhookHost: OPENCLAW_TELEGRAM_WEBHOOK_HOST,
      webhookPath: OPENCLAW_TELEGRAM_INTERNAL_WEBHOOK_PATH,
    };
    if (origin) {
      const webhookUrl = new URL(TELEGRAM_PUBLIC_WEBHOOK_PATH, `${origin}/`);
      const bypassSecret = getProtectionBypassSecret();
      if (bypassSecret) {
        webhookUrl.searchParams.set("x-vercel-protection-bypass", bypassSecret);
      }
      telegramConfig.webhookUrl = webhookUrl.toString();
    }
    if (telegramWebhookSecret) {
      telegramConfig.webhookSecret = telegramWebhookSecret;
    }
    channels.telegram = telegramConfig;
    config.channels = channels;
  }

  // Slack HTTP mode: OpenClaw validates signatures and handles replies natively
  // on the main gateway port (3000) at the configured webhook path.
  if (slackCredentials) {
    const channels = (config.channels as Record<string, unknown>) ?? {};
    channels.slack = {
      enabled: true,
      mode: "http",
      botToken: slackCredentials.botToken,
      signingSecret: slackCredentials.signingSecret,
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: ["*"],
      webhookPath: "/slack/events",
    };
    config.channels = channels;
  }

  // WhatsApp gateway-native config: policy fields only — no credentials,
  // no webhook setup.  Auth lives on the sandbox filesystem; the gateway
  // plugin owns the socket lifecycle.
  if (whatsappConfig?.enabled) {
    const channels = (config.channels as Record<string, unknown>) ?? {};
    channels.whatsapp = {
      enabled: true,
      dmPolicy: whatsappConfig.dmPolicy ?? "pairing",
      allowFrom: whatsappConfig.allowFrom ?? [],
      groupPolicy: whatsappConfig.groupPolicy ?? "allowlist",
      groupAllowFrom: whatsappConfig.groupAllowFrom ?? [],
      ...(whatsappConfig.groups ? { groups: whatsappConfig.groups } : {}),
    };
    config.channels = channels;
  }

  return JSON.stringify(config);
}

export const GATEWAY_CONFIG_HASH_VERSION = 1;
const GATEWAY_CONFIG_HASH_PROXY_ORIGIN = "https://proxy.invalid";

export type GatewayConfigHashInput = {
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  slackCredentials?: { botToken: string; signingSecret: string };
  whatsappConfig?: WhatsAppGatewayConfig;
};

export function computeGatewayConfigHash(input: GatewayConfigHashInput): string {
  const configJson = buildGatewayConfig(
    undefined,
    GATEWAY_CONFIG_HASH_PROXY_ORIGIN,
    input.telegramBotToken,
    input.slackCredentials,
    input.telegramWebhookSecret,
    input.whatsappConfig,
  );
  return createHash("sha256")
    .update(`gateway-config-hash:v${GATEWAY_CONFIG_HASH_VERSION}\0`)
    .update(configJson)
    .digest("hex");
}

export function buildForcePairScript(): string {
  return `import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

async function backupIfPresent(filePath) {
  const backupPath = \`\${filePath}.corrupt-\${Date.now()}\`;
  try {
    await fs.copyFile(filePath, backupPath);
    return { backupPath, backupError: null };
  } catch (error) {
    return {
      backupPath: null,
      backupError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function failCorrupt(filePath, reason, error) {
  const { backupPath, backupError } = await backupIfPresent(filePath);
  console.error(JSON.stringify({
    event: "force_pair.corrupt_state",
    filePath,
    backupPath,
    backupError,
    reason,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}

async function readJsonOrMissing(filePath, reason) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    await failCorrupt(filePath, reason, error);
    return null;
  }
}

const stateDir = process.argv[2];
const identityDir = path.join(stateDir, "identity");
const identityPath = path.join(identityDir, "device.json");

let identity = await readJsonOrMissing(identityPath, "device_json_invalid");
if (identity === null) {
  await fs.mkdir(identityDir, { recursive: true });
  const kp = crypto.generateKeyPairSync("ed25519");
  identity = {
    publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAtMs: Date.now(),
  };
  await fs.writeFile(identityPath, JSON.stringify(identity, null, 2) + "\\n", { mode: 0o600 });
}

if (
  !identity ||
  typeof identity !== "object" ||
  typeof identity.publicKeyPem !== "string" ||
  typeof identity.privateKeyPem !== "string"
) {
  await failCorrupt(
    identityPath,
    "device_json_shape_invalid",
    "Expected publicKeyPem/privateKeyPem strings",
  );
}

let spkiDer;
try {
  const pubKey = crypto.createPublicKey(identity.publicKeyPem);
  spkiDer = pubKey.export({ type: "spki", format: "der" });
} catch (error) {
  await failCorrupt(
    identityPath,
    "device_json_key_invalid",
    error,
  );
}
const prefix = Buffer.from("302a300506032b6570032100", "hex");
if (
  spkiDer.length !== prefix.length + 32 ||
  !spkiDer.subarray(0, prefix.length).equals(prefix)
) {
  await failCorrupt(
    identityPath,
    "device_json_key_invalid",
    "Unexpected ed25519 public key format",
  );
}

const rawKey = spkiDer.subarray(prefix.length);
const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
const publicKeyRawBase64Url = rawKey
  .toString("base64")
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

const devicesDir = path.join(stateDir, "devices");
await fs.mkdir(devicesDir, { recursive: true });

const pairedPath = path.join(devicesDir, "paired.json");
let paired = await readJsonOrMissing(pairedPath, "paired_json_invalid");
if (paired === null) {
  paired = {};
}

if (!paired || typeof paired !== "object" || Array.isArray(paired)) {
  await failCorrupt(
    pairedPath,
    "paired_json_shape_invalid",
    "Expected JSON object",
  );
}

// Purge stale entries that lack role/scopes — they were written before the
// scopes fix and cause "missing scope: operator.write" rejections from the
// gateway when the old device identity is used for token auth.
for (const [id, entry] of Object.entries(paired)) {
  if (!entry || typeof entry !== "object" || !entry.role) {
    delete paired[id];
  }
}

paired[deviceId] = {
  deviceId,
  publicKey: publicKeyRawBase64Url,
  approvedAtMs: Date.now(),
  role: "operator",
  roles: ["operator"],
  scopes: [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
  ],
};

await fs.writeFile(pairedPath, JSON.stringify(paired, null, 2) + "\\n", { mode: 0o600 });

// Register the gateway token in device-auth.json so the HTTP API grants
// operator scopes to Bearer <gateway-token> requests.  OpenClaw 2026.3.28
// enforces scopes on token-authenticated HTTP endpoints — without this,
// chat completions return "missing scope: operator.write".
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
if (gatewayToken) {
  const deviceAuthPath = path.join(identityDir, "device-auth.json");
  const deviceAuth = {
    version: 1,
    deviceId,
    tokens: {
      operator: {
        token: gatewayToken,
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.pairing",
        ],
        updatedAtMs: Date.now(),
      },
    },
  };
  await fs.writeFile(deviceAuthPath, JSON.stringify(deviceAuth, null, 2) + "\\n", { mode: 0o600 });
}

console.log("Force-paired device identity");
`;
}

export function buildStartupScript(): string {
  return `#!/bin/bash
set -euo pipefail
mkdir -p "${OPENCLAW_STATE_DIR}/devices" "${OPENCLAW_STATE_DIR}/identity"
rm -f "${OPENCLAW_STATE_DIR}/devices/paired.json" "${OPENCLAW_STATE_DIR}/devices/pending.json"
${buildNetLearnWriteShell()}
${buildGatewayEnvShell()}
# Pre-register the gateway token in device-auth.json BEFORE the gateway starts
# so the HTTP API grants operator scopes to Bearer <gateway-token> requests.
# OpenClaw 2026.3.28 caches token auth at startup — writing after launch has no effect.
if [ -n "\${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const stateDir = "${OPENCLAW_STATE_DIR}";
const identityDir = path.join(stateDir, "identity");
fs.mkdirSync(identityDir, { recursive: true });
const identityPath = path.join(identityDir, "device.json");
let identity;
try { identity = JSON.parse(fs.readFileSync(identityPath, "utf8")); } catch {}
if (!identity) {
  const kp = crypto.generateKeyPairSync("ed25519");
  identity = { publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }), createdAtMs: Date.now() };
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\\n", { mode: 0o600 });
}
const pubKey = crypto.createPublicKey(identity.publicKeyPem);
const spkiDer = pubKey.export({ type: "spki", format: "der" });
const rawKey = spkiDer.subarray(12);
const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
const publicKeyRawBase64Url = rawKey.toString("base64").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"");
const devicesDir = path.join(stateDir, "devices");
fs.mkdirSync(devicesDir, { recursive: true });
const pairedPath = path.join(devicesDir, "paired.json");
let paired = {};
try { paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")); } catch {}
if (!paired || typeof paired !== "object" || Array.isArray(paired)) paired = {};
for (const [id, e] of Object.entries(paired)) { if (!e || typeof e !== "object" || !e.role) delete paired[id]; }
paired[deviceId] = { deviceId, publicKey: publicKeyRawBase64Url, approvedAtMs: Date.now(), role: "operator", roles: ["operator"], scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"] };
fs.writeFileSync(pairedPath, JSON.stringify(paired, null, 2) + "\\n", { mode: 0o600 });
const gt = process.env.OPENCLAW_GATEWAY_TOKEN;
if (gt) { const dap = path.join(identityDir, "device-auth.json"); fs.writeFileSync(dap, JSON.stringify({ version: 1, deviceId, tokens: { operator: { token: gt, role: "operator", scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"], updatedAtMs: Date.now() } } }, null, 2) + "\\n", { mode: 0o600 }); }
console.error(JSON.stringify({ event: "startup.pre_gateway_pair", deviceId }));
' 2>&1 || echo '{"event":"startup.pre_gateway_pair_failed"}' >&2
fi
${buildGatewayKillShell()}
${buildGatewayLaunchShell()}
_learning_log=/tmp/shell-commands-for-learning.log
touch "$_learning_log"
${buildGatewayPortProfileShell()}
_home="\${HOME:-/home/vercel-sandbox}"
if ! grep -q 'shell-commands-for-learning' "$_home/.zshrc" 2>/dev/null; then
  cat >> "$_home/.zshrc" 2>/dev/null <<'ZSHEOF' || true
preexec() { printf '%s\\n' "$1" >> /tmp/shell-commands-for-learning.log; }
ZSHEOF
fi
if ! grep -q 'shell-commands-for-learning' "$_home/.bashrc" 2>/dev/null; then
  cat >> "$_home/.bashrc" 2>/dev/null <<'BASHEOF' || true
trap 'printf "%s\\n" "$BASH_COMMAND" >> /tmp/shell-commands-for-learning.log' DEBUG
BASHEOF
fi
`;
}

/**
 * Restore-only startup script optimised for snapshot resume.
 *
 * Differences from the generic startup script:
 * - Does NOT clear paired.json / pending.json — force-pair is inlined below.
 * - Does NOT install shell hooks — they are already baked into the snapshot.
 * - Inlines device identity force-pair so we avoid a second `node` process.
 *
 * The script reads fresh tokens from on-disk files that the restore path has
 * already written via writeRestoreCredentialFiles.
 */
export function buildFastRestoreScript(): string {
  return `#!/bin/bash
set -euo pipefail
# Write config + credentials from env (sub-ms local write instead of
# 5-9s writeFiles API call).  Falls back to snapshot files if env is empty.
install -d -m 700 "${OPENCLAW_STATE_DIR}"
if [ -n "\${OPENCLAW_CONFIG_JSON_B64:-}" ]; then
  (umask 077; printf '%s' "\$OPENCLAW_CONFIG_JSON_B64" | base64 -d > "${OPENCLAW_CONFIG_PATH}")
fi
if [ -n "\${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  gateway_token="\$OPENCLAW_GATEWAY_TOKEN"
  (umask 077; printf '%s' "\$gateway_token" > "${OPENCLAW_GATEWAY_TOKEN_PATH}")
else
  gateway_token="$(cat "${OPENCLAW_GATEWAY_TOKEN_PATH}" 2>/dev/null || true)"
fi
if [ -z "\$gateway_token" ]; then
  echo '{"event":"fast_restore.error","reason":"empty_gateway_token"}' >&2
  exit 1
fi
# AI Gateway API key: always read from disk file (written fresh during restore).
# The baked-in env var from sandbox create time is stale on resume — ignore it.
# Also injected via network policy transform (defense-in-depth).
AI_GATEWAY_API_KEY="$(cat "${OPENCLAW_AI_GATEWAY_API_KEY_PATH}" 2>/dev/null || true)"
if [ -n "\$AI_GATEWAY_API_KEY" ]; then
  export AI_GATEWAY_API_KEY="\$AI_GATEWAY_API_KEY"
  export OPENAI_API_KEY="\$AI_GATEWAY_API_KEY"
fi
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_PORT}"
export OPENCLAW_GATEWAY_TOKEN="\$gateway_token"
export OPENAI_BASE_URL="https://ai-gateway.vercel.sh/v1"
${buildNetLearnWriteShell()}
export NODE_OPTIONS="\${NODE_OPTIONS:-} --require=${OPENCLAW_NET_LEARN_PATH}"
# Integrity check: fail fast if bundled peer dependencies are missing.
# The artifact/snapshot must ship @buape/carbon — runtime repair is not
# acceptable because it makes restores nondeterministic.
OC_PKG="/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw"
OC_CARBON_PATH="\$OC_PKG/node_modules/@buape/carbon"
if [ ! -d "\$OC_CARBON_PATH" ]; then
  echo '{"event":"fast_restore.missing_dependency","package":"@buape/carbon","path":"'\$OC_CARBON_PATH'","action":"rebuild_artifact"}' >&2
  exit 1
fi
# Snapshot invariant: reject snapshots that still contain the stale
# host-scheduler skill.  It told the agent "the cron tool is disabled"
# and directed it to a removed script.  The native cron tool works
# correctly and needs no skill wrapper.  Fail instead of cleaning up
# so broken snapshots are surfaced rather than silently repaired.
STALE_HOST_SCHEDULER_DIR="${OPENCLAW_STATE_DIR}/skills/host-scheduler"
if [ -e "\$STALE_HOST_SCHEDULER_DIR" ]; then
  echo '{"event":"fast_restore.stale_snapshot_content","path":"skills/host-scheduler","action":"rebuild_snapshot"}' >&2
  exit 1
fi
# Kill any existing gateway process — persistent sandboxes may still have
# the previous gateway running after resume.  Snapshots have no running
# processes so this is a no-op for snapshot restores.
_kill_started=\$(date +%s%N 2>/dev/null || echo 0)
_killed_existing_gateway=0
_sleep_ms=0
if pkill -f 'openclaw.gateway' 2>/dev/null; then
  _killed_existing_gateway=1
  # Poll for process death instead of fixed 1-second sleep.
  # pgrep exits non-zero when no matching process exists.
  _wait_deadline=\$(( \$(date +%s) + 3 ))
  while pgrep -f 'openclaw.gateway' > /dev/null 2>&1; do
    if [ "\$(date +%s)" -ge "\$_wait_deadline" ]; then
      _sleep_ms=3000
      break
    fi
    sleep 0.05
    _sleep_ms=\$(( _sleep_ms + 50 ))
  done
fi
_kill_finished=\$(date +%s%N 2>/dev/null || echo 0)
_kill_ms=0
if [ "\$_kill_started" != "0" ] && [ "\$_kill_finished" != "0" ]; then
  _kill_ms=\$(( (_kill_finished - _kill_started) / 1000000 ))
fi
printf '{"event":"fast_restore.gateway_reset","killed":%s,"sleepMs":%d,"killMs":%d}\\n' \\
  "\$([ "\$_killed_existing_gateway" = "1" ] && echo true || echo false)" \\
  "\$_sleep_ms" \\
  "\$_kill_ms" >&2
# Write device-auth.json BEFORE gateway starts so it caches the token scopes.
node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const stateDir = "${OPENCLAW_STATE_DIR}";
const identityDir = path.join(stateDir, "identity");
fs.mkdirSync(identityDir, { recursive: true });
const identityPath = path.join(identityDir, "device.json");
let identity;
try { identity = JSON.parse(fs.readFileSync(identityPath, "utf8")); } catch {}
if (!identity) {
  const kp = crypto.generateKeyPairSync("ed25519");
  identity = { publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }), createdAtMs: Date.now() };
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\\n", { mode: 0o600 });
}
const pubKey = crypto.createPublicKey(identity.publicKeyPem);
const rawKey = pubKey.export({ type: "spki", format: "der" }).subarray(12);
const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
const gt = process.env.OPENCLAW_GATEWAY_TOKEN;
if (gt) { const dap = path.join(identityDir, "device-auth.json"); fs.writeFileSync(dap, JSON.stringify({ version: 1, deviceId, tokens: { operator: { token: gt, role: "operator", scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"], updatedAtMs: Date.now() } } }, null, 2) + "\\n", { mode: 0o600 }); }
console.error(JSON.stringify({ event: "fast_restore.pre_gateway_auth", deviceId }));
' 2>&1 || echo '{"event":"fast_restore.pre_gateway_auth_failed"}' >&2
echo '{"event":"fast_restore.start_gateway"}' >&2
# Always use Node for the gateway — Bun's WebSocket implementation does not
# expose socket._socket.remoteAddress, which causes isLocalClient to return
# false and blocks device auto-pairing for local CLI/tool connections (cron,
# gateway status, etc.).
setsid ${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT} --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &
echo '{"event":"fast_restore.readiness_loop"}' >&2
case "\${1:-}" in ''|*[!0-9]*) _ready_timeout=60 ;; *) _ready_timeout=\$1 ;; esac
_ready_start=\$(date +%s%N 2>/dev/null || echo 0)
_attempts=0
_ready=0
_deadline=\$(( \$(date +%s) + _ready_timeout ))
while [ "\$(date +%s)" -lt "\$_deadline" ]; do
  _attempts=\$((_attempts + 1))
  _http_code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:${OPENCLAW_PORT}/ 2>/dev/null || true)
  # Log every 20th attempt for visibility.
  if [ "\$((_attempts % 20))" = "0" ] && [ "\$_attempts" -gt 0 ]; then
    echo "{\"event\":\"fast_restore.probe\",\"attempt\":\$_attempts,\"http_code\":\"\$_http_code\"}" >&2
  fi
  if [ "\$_http_code" -gt 0 ] 2>/dev/null && [ "\$_http_code" -lt 500 ] 2>/dev/null; then
    _ready=1
    break
  fi
  sleep 0.1
done
_ready_end=\$(date +%s%N 2>/dev/null || echo 0)
_ready_ms=0
if [ "\$_ready_start" != "0" ] && [ "\$_ready_end" != "0" ]; then
  _ready_ms=\$(( (_ready_end - _ready_start) / 1000000 ))
fi
if [ "\$_ready" = "1" ]; then
  printf '{"ready":true,"attempts":%d,"readyMs":%d}\\n' "\$_attempts" "\$_ready_ms"
  # Clear stale pending pairing requests — if a previous CLI connection
  # left a non-silent pending request, it blocks auto-pairing for all
  # subsequent local CLI connections (cron tool, gateway status, etc.).
  rm -f "${OPENCLAW_STATE_DIR}/devices/pending.json"
  # Force-pair: re-establish device identity in paired.json so local CLI
  # connections (cron tool, gateway status, etc.) are accepted by the
  # gateway without manual pairing approval.
  node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const stateDir = "${OPENCLAW_STATE_DIR}";
const identityDir = path.join(stateDir, "identity");
const identityPath = path.join(identityDir, "device.json");
let identity;
try { identity = JSON.parse(fs.readFileSync(identityPath, "utf8")); } catch {}
if (!identity) {
  fs.mkdirSync(identityDir, { recursive: true });
  const kp = crypto.generateKeyPairSync("ed25519");
  identity = {
    publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\\n", { mode: 0o600 });
}
const pubKey = crypto.createPublicKey(identity.publicKeyPem);
const spkiDer = pubKey.export({ type: "spki", format: "der" });
const rawKey = spkiDer.subarray(12);
const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
const publicKeyRawBase64Url = rawKey.toString("base64").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"");
const devicesDir = path.join(stateDir, "devices");
fs.mkdirSync(devicesDir, { recursive: true });
const pairedPath = path.join(devicesDir, "paired.json");
let paired = {};
try { paired = JSON.parse(fs.readFileSync(pairedPath, "utf8")); } catch {}
if (!paired || typeof paired !== "object" || Array.isArray(paired)) paired = {};
for (const [id, entry] of Object.entries(paired)) { if (!entry || typeof entry !== "object" || !entry.role) delete paired[id]; }
paired[deviceId] = { deviceId, publicKey: publicKeyRawBase64Url, approvedAtMs: Date.now(), role: "operator", roles: ["operator"], scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"] };
fs.writeFileSync(pairedPath, JSON.stringify(paired, null, 2) + "\\n", { mode: 0o600 });
const gt = process.env.OPENCLAW_GATEWAY_TOKEN;
if (gt) { const dap = path.join(stateDir, "identity", "device-auth.json"); fs.mkdirSync(path.dirname(dap), { recursive: true }); fs.writeFileSync(dap, JSON.stringify({ version: 1, deviceId, tokens: { operator: { token: gt, role: "operator", scopes: ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"], updatedAtMs: Date.now() } } }, null, 2) + "\\n", { mode: 0o600 }); }
console.error(JSON.stringify({ event: "fast_restore.force_pair", deviceId }));
' 2>&1 || echo '{"event":"fast_restore.force_pair_failed"}' >&2
  # Ensure OPENCLAW_GATEWAY_PORT is in the shell profile so agent tools
  # (cron, gateway status) can connect.  Old snapshots may lack this.
  ${buildGatewayPortProfileShell()}
  # Telegram deleteWebhook: removed — the app's webhook route handles
  #   incoming messages and forwards to the sandbox fast path when running.
  #   Deleting the webhook here created a deadlock: no webhook → no messages
  #   → no queue processing → reconciliation never re-registers the URL.
  echo '{"event":"fast_restore.complete"}' >&2
else
  printf '{"ready":false,"attempts":%d,"readyMs":%d}\\n' "\$_attempts" "\$_ready_ms"
  echo '{"event":"fast_restore.readiness_timeout"}' >&2
  exit 1
fi
`;
}

export function buildImageGenSkill(): string {
  return `---
name: openai-image-gen
description: Generate images via Vercel AI Gateway (gemini-3.1-flash-image-preview, gpt-image-1, dall-e-3)
user-invocable: true
metadata:
  openclaw:
    emoji: "🖼️"
    requires:
      bins: ["node"]
      env: []
---

# Image Generation (Vercel AI Gateway)

Generate images using models routed through the Vercel AI Gateway. Default: Gemini 3.1 Flash (chat-based image generation with editing support).

## Run

\`\`\`bash
node {baseDir}/scripts/gen.mjs --prompt "DESCRIPTION"
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/gen.mjs --prompt "a cute cat" --count 4
node {baseDir}/scripts/gen.mjs --prompt "mountain landscape" --model gpt-image-1
node {baseDir}/scripts/gen.mjs --prompt "abstract art" --model dall-e-3 --size 1792x1024
node {baseDir}/scripts/gen.mjs --prompt "logo" --output logo.png
\`\`\`

## Image Editing & Style Transfer (Gemini only)

Pass reference images with \`--image\` for editing, style transfer, or combining:

\`\`\`bash
node {baseDir}/scripts/gen.mjs --image ./photo.png --prompt "Add a wizard hat to the cat"
node {baseDir}/scripts/gen.mjs --image ./photo.png --prompt "Make this look cyberpunk"
node {baseDir}/scripts/gen.mjs --image ./a.png --image ./b.png --prompt "Combine these into one scene"
\`\`\`

Up to 10 reference images supported for Gemini models.

## Parameters

- \`--prompt\` (required): Image description or editing instruction
- \`--image\`: Reference image path for editing/style transfer (repeatable, up to 10 for Gemini)
- \`--model\`: google/gemini-3.1-flash-image-preview (default), gpt-image-1, dall-e-3
- \`--size\`: 1024x1024 (default), 1536x1024, 1024x1536, 1792x1024, auto
- \`--count\`: Number of images to generate (default: 1). Gemini runs parallel calls; OpenAI uses native n param.
- \`--quality\`: auto (default), high, medium, low
- \`--output\`: Output filename (default: generated-image.png)

## Output

The script saves PNG images to disk and prints \`MEDIA:\` lines with absolute paths (one per line).
OpenClaw renders these inline and delivers to all channels (Telegram, Slack, WhatsApp, Discord) automatically.

**NEVER call \`message send\` or \`message send --media\` after running gen.mjs.** The \`MEDIA:\` lines already handle ALL delivery — inline rendering AND channel delivery. Calling \`message send\` separately causes every image to appear twice in the channel. This applies to every channel and every model. There are zero exceptions. Your task is complete once gen.mjs finishes.
`;
}

export function buildImageGenScript(): string {
  return `import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    image: { type: "string", multiple: true },
    model: { type: "string", default: "google/gemini-3.1-flash-image-preview" },
    size: { type: "string", default: "1024x1024" },
    count: { type: "string", default: "1" },
    quality: { type: "string", default: "auto" },
    output: { type: "string", default: "generated-image.png" },
  },
});

if (!values.prompt) {
  console.error("Usage: node gen.mjs --prompt \\"description\\" [--image PATH]... [--model MODEL] [--count N] [--output FILE]");
  process.exit(1);
}

// AI Gateway API key is injected via network policy header transform —
// the placeholder below is overwritten by the firewall layer.
const apiKey = "injected-by-firewall";

const n = Math.min(Math.max(parseInt(values.count, 10) || 1, 1), 8);
const ext = path.extname(values.output) || ".png";
const base = path.basename(values.output, ext);
const dir = path.dirname(values.output);
const saved = [];

// Gemini models use chat completions with image output modality
const isGemini = values.model.startsWith("google/") || values.model.includes("gemini");

// Load reference images (for editing/style transfer)
const refImages = values.image || [];
const imageDataUris = [];
for (const imgPath of refImages) {
  const resolved = path.resolve(imgPath);
  const buf = await readFile(resolved);
  const b64 = buf.toString("base64");
  const mimeType = resolved.endsWith(".jpg") || resolved.endsWith(".jpeg") ? "image/jpeg"
    : resolved.endsWith(".webp") ? "image/webp"
    : "image/png";
  imageDataUris.push("data:" + mimeType + ";base64," + b64);
}

async function geminiGenerate() {
  const content = [];
  for (const uri of imageDataUris) {
    content.push({ type: "image_url", image_url: { url: uri } });
  }
  content.push({ type: "text", text: values.prompt });

  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: values.model,
      messages: [{ role: "user", content }],
      modalities: ["text", "image"],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("Image generation failed (" + res.status + "): " + text);
  }

  const result = await res.json();
  const msg = result?.choices?.[0]?.message;
  const parts = msg?.images || (Array.isArray(msg?.content) ? msg.content : []);
  const buffers = [];
  for (const part of parts) {
    const url = part?.image_url?.url || part?.image_url;
    if (typeof url === "string" && url.startsWith("data:image")) {
      const match = url.match(/^data:image\\/[^;]+;base64,(.+)$/);
      if (match) buffers.push(Buffer.from(match[1], "base64"));
    }
  }
  return buffers;
}

if (isGemini) {
  const results = await Promise.all(Array.from({ length: n }, () => geminiGenerate()));
  const allBuffers = results.flat();
  for (let i = 0; i < allBuffers.length; i++) {
    const filename = allBuffers.length === 1
      ? path.join(dir, base + ext)
      : path.join(dir, base + "-" + (i + 1) + ext);
    await writeFile(filename, allBuffers[i]);
    saved.push(filename);
  }
} else {
  const res = await fetch("https://ai-gateway.vercel.sh/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({ model: values.model, prompt: values.prompt, n, size: values.size, quality: values.quality }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Image generation failed (" + res.status + "): " + text);
    process.exit(1);
  }

  const result = await res.json();
  const images = result.data || [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const filename = images.length === 1
      ? path.join(dir, base + ext)
      : path.join(dir, base + "-" + (i + 1) + ext);
    if (img.b64_json) {
      await writeFile(filename, Buffer.from(img.b64_json, "base64"));
      saved.push(filename);
    } else if (img.url) {
      const dl = await fetch(img.url);
      if (dl.ok) { await writeFile(filename, Buffer.from(await dl.arrayBuffer())); saved.push(filename); }
    }
  }
}

if (saved.length === 0) { console.error("No images were saved"); process.exit(1); }
for (const f of saved) console.log("MEDIA:" + path.resolve(f));
console.error("\\n[gen.mjs] Images delivered via MEDIA: lines. Do NOT call 'message send --media' — that would send duplicates.");
`;
}

export function buildWebSearchSkill(): string {
  return `---
name: web-search
description: Search the web via Vercel AI Gateway chat completions function calling
user-invocable: true
metadata:
  openclaw:
    emoji: "🔎"
    requires:
      bins: ["node"]
      env: []
---

# Web Search (Vercel AI Gateway)

Search the web by calling the chat completions endpoint with a \`web_search\` function tool.

## Run

\`\`\`bash
node {baseDir}/scripts/search.mjs --query "LATEST AI NEWS"
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/search.mjs --query "best ramen in nyc"
node {baseDir}/scripts/search.mjs "vercel sandbox network policy docs"
node {baseDir}/scripts/search.mjs --query "openclaw setup" --model gpt-4o
\`\`\`

## Parameters

- \`--query\` (required): Search query text. Positional args are also accepted.
- \`--model\`: Chat model ID (default: gpt-4o)

## Output

Prints the requested search query and any model reasoning text.
`;
}

export function buildWebSearchScript(): string {
  return `import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    query: { type: "string" },
    model: { type: "string", default: "gpt-4o" },
  },
  allowPositionals: true,
});

const query = (values.query ?? positionals.join(" ")).trim();
if (!query) {
  console.error("Usage: node search.mjs --query \\"query text\\" [--model MODEL]");
  process.exit(1);
}

// AI Gateway API key is injected via network policy header transform —
// the placeholder below is overwritten by the firewall layer.
const apiKey = "injected-by-firewall";

const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({
    model: values.model,
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
    ],
    tool_choice: "auto",
    messages: [{ role: "user", content: query }],
  }),
});

if (!response.ok) {
  const text = await response.text();
  console.error("Web search failed (" + response.status + "): " + text);
  process.exit(1);
}

const payload = await response.json();
const message = payload?.choices?.[0]?.message;

function extractText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\\n");
  }
  return "";
}

const reasoning = extractText(message?.content);
const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
const webSearchCall = toolCalls.find(
  (toolCall) => toolCall?.type === "function" && toolCall?.function?.name === "web_search"
);

if (webSearchCall) {
  let searchedQuery = query;
  const toolArgs = webSearchCall?.function?.arguments;
  if (typeof toolArgs === "string" && toolArgs.trim()) {
    try {
      const parsed = JSON.parse(toolArgs);
      if (typeof parsed?.query === "string" && parsed.query.trim()) {
        searchedQuery = parsed.query.trim();
      }
    } catch {}
  }

  console.log("Tool: web_search");
  console.log("Query: " + searchedQuery);
  if (reasoning) {
    console.log("Reasoning: " + reasoning);
  }
  process.exit(0);
}

if (reasoning) {
  console.log(reasoning);
  process.exit(0);
}

console.log(JSON.stringify(payload, null, 2));
`;
}

export function buildVisionSkill(): string {
  return `---
name: vision
description: Analyze an image via Vercel AI Gateway chat completions (gpt-4o)
user-invocable: true
metadata:
  openclaw:
    emoji: "👁️"
    requires:
      bins: ["node"]
      env: []
---

# Vision (Vercel AI Gateway)

Analyze images by sending a text prompt plus image data URI content to \`/v1/chat/completions\`.

## Run

\`\`\`bash
node {baseDir}/scripts/analyze.mjs --image /path/to/image.png
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/analyze.mjs --image ./photo.jpg
node {baseDir}/scripts/analyze.mjs ./photo.jpg --prompt "Summarize what is happening"
node {baseDir}/scripts/analyze.mjs --image ./diagram.webp --prompt "Extract key details"
\`\`\`

## Parameters

- \`--image\` (required): Path to the image file. First positional arg is also accepted.
- \`--prompt\`: Analysis instruction (default: "Describe this image in detail.")
- \`--model\`: Vision-capable model (default: gpt-4o)

## Output

Prints the model's text description/analysis.
`;
}

export function buildVisionScript(): string {
  return `import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

function toImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

const { values, positionals } = parseArgs({
  options: {
    image: { type: "string" },
    prompt: { type: "string", default: "Describe this image in detail." },
    model: { type: "string", default: "gpt-4o" },
  },
  allowPositionals: true,
});

const imagePath = (values.image ?? positionals[0] ?? "").trim();
if (!imagePath) {
  console.error("Usage: node analyze.mjs --image /path/to/file.png [--prompt TEXT] [--model MODEL]");
  process.exit(1);
}

// AI Gateway API key is injected via network policy header transform —
// the placeholder below is overwritten by the firewall layer.
const apiKey = "injected-by-firewall";

const image = await readFile(imagePath);
const imageDataUri = "data:" + toImageMimeType(imagePath) + ";base64," + image.toString("base64");
const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({
    model: values.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: values.prompt },
          { type: "image_url", image_url: { url: imageDataUri } },
        ],
      },
    ],
  }),
});

if (!response.ok) {
  const text = await response.text();
  console.error("Vision request failed (" + response.status + "): " + text);
  process.exit(1);
}

const payload = await response.json();
const content = payload?.choices?.[0]?.message?.content;

if (typeof content === "string" && content.trim()) {
  console.log(content.trim());
  process.exit(0);
}

if (Array.isArray(content)) {
  const text = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\\n");
  if (text) {
    console.log(text);
    process.exit(0);
  }
}

console.log(JSON.stringify(payload, null, 2));
`;
}

export function buildTtsSkill(): string {
  return `---
name: tts
description: Generate speech audio via Vercel AI Gateway /v1/audio/speech
user-invocable: true
metadata:
  openclaw:
    emoji: "🔊"
    requires:
      bins: ["node"]
      env: []
---

# Text-to-Speech (Vercel AI Gateway)

Convert text to speech using OpenAI's \`gpt-4o-mini-tts\` model through Vercel AI Gateway.

## Run

\`\`\`bash
node {baseDir}/scripts/speak.mjs --text "Hello from OpenClaw"
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/speak.mjs --text "Daily summary" --voice alloy
node {baseDir}/scripts/speak.mjs "Ship it!" --output ./ship-it.mp3
\`\`\`

## Parameters

- \`--text\` (required): Input text to synthesize. Positional args are also accepted.
- \`--voice\`: Voice ID (default: alloy)
- \`--output\`: Output file path (default: speech.mp3)

## Output

Writes an MP3 file and prints a single \`MEDIA:\` line with the absolute output path.
`;
}

export function buildTtsScript(): string {
  // NOTE: Uses ai-gateway.vercel.sh instead of api.openai.com (unlike moltbot)
  // so that OIDC/gateway tokens work correctly.
  return `import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values, positionals } = parseArgs({
  options: {
    text: { type: "string" },
    voice: { type: "string", default: "alloy" },
    output: { type: "string", default: "speech.mp3" },
  },
  allowPositionals: true,
});

const text = (values.text ?? positionals.join(" ")).trim();
if (!text) {
  console.error("Usage: node speak.mjs --text \\"hello world\\" [--voice VOICE] [--output FILE]");
  process.exit(1);
}

// AI Gateway API key is injected via network policy header transform —
// the placeholder below is overwritten by the firewall layer.
const apiKey = "injected-by-firewall";

const response = await fetch("https://ai-gateway.vercel.sh/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: values.voice,
    input: text,
    format: "mp3",
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error("TTS request failed (" + response.status + "): " + errorText);
  process.exit(1);
}

const resolvedOutputPath = path.resolve(values.output);
const audio = Buffer.from(await response.arrayBuffer());
await writeFile(resolvedOutputPath, audio);
console.log("MEDIA:" + resolvedOutputPath);
`;
}

export function buildStructuredExtractSkill(): string {
  return `---
name: structured-extract
description: Deterministic JSON extraction via chat completions json_schema format
user-invocable: true
metadata:
  openclaw:
    emoji: "🧩"
    requires:
      bins: ["node"]
      env: []
---

# Structured Extract (Vercel AI Gateway)

Extract deterministic JSON from text using \`response_format: { type: "json_schema" }\`.

## Run

\`\`\`bash
node {baseDir}/scripts/extract.mjs --text "Invoice 123 total is $45.67" --schema '{"type":"object","properties":{"invoice":{"type":"string"},"total":{"type":"number"}},"required":["invoice","total"],"additionalProperties":false}'
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/extract.mjs --text "..." --schema '{...}'
node {baseDir}/scripts/extract.mjs --text "..." --schema-file ./schema.json
node {baseDir}/scripts/extract.mjs --text "..." --schema-file ./schema.json --model gpt-4o-mini
\`\`\`

## Parameters

- \`--text\` (required): Source text to extract from.
- \`--schema\`: JSON schema as an inline JSON string.
- \`--schema-file\`: Path to a JSON schema file.
- \`--model\`: Chat model ID (default: gpt-4o)

## Output

Prints parsed structured JSON matching the provided schema.
`;
}

export function buildStructuredExtractScript(): string {
  return `import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

function parseSchema(input) {
  try {
    return JSON.parse(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error("Invalid JSON schema: " + reason);
  }
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part && typeof part === "object")
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\\n")
    .trim();
}

const { values } = parseArgs({
  options: {
    text: { type: "string" },
    schema: { type: "string" },
    "schema-file": { type: "string" },
    model: { type: "string", default: "gpt-4o" },
  },
});

const inputText = (values.text ?? "").trim();
if (!inputText) {
  console.error("Usage: node extract.mjs --text \\"source text\\" (--schema '{...}' | --schema-file ./schema.json) [--model MODEL]");
  process.exit(1);
}

if (!values.schema && !values["schema-file"]) {
  console.error("Either --schema or --schema-file is required");
  process.exit(1);
}

// AI Gateway API key is injected via network policy header transform —
// the placeholder below is overwritten by the firewall layer.
const apiKey = "injected-by-firewall";

const schemaSource = values.schema ?? await readFile(values["schema-file"], "utf8");
let schema;
try {
  schema = parseSchema(schemaSource);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({
    model: values.model,
    messages: [
      {
        role: "system",
        content: "Extract structured data from user text and only return valid JSON matching the provided schema.",
      },
      {
        role: "user",
        content: inputText,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "extraction",
        schema,
      },
    },
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error("Structured extract request failed (" + response.status + "): " + errorText);
  process.exit(1);
}

const payload = await response.json();
const content = payload?.choices?.[0]?.message?.content;
const contentText = extractTextContent(content);

if (!contentText) {
  console.error("Structured extract response missing content");
  process.exit(1);
}

try {
  const parsed = JSON.parse(contentText);
  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error("Structured extract response was not valid JSON: " + reason);
  process.exit(1);
}
`;
}

export function buildEmbeddingsSkill(): string {
  return `---
name: embeddings
description: Generate text embeddings via Vercel AI Gateway /v1/embeddings
user-invocable: true
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["node"]
      env: []
---

# Embeddings (Vercel AI Gateway)

Generate vector embeddings for text or files using AI Gateway's OpenAI-compatible embeddings endpoint.

## Run

\`\`\`bash
node {baseDir}/scripts/embed.mjs --text "OpenClaw skills use markdown plus scripts"
\`\`\`

## More examples

\`\`\`bash
node {baseDir}/scripts/embed.mjs --text "first string" --text "second string"
node {baseDir}/scripts/embed.mjs --file ./README.md
node {baseDir}/scripts/embed.mjs --file ./docs/spec.md --model openai/text-embedding-3-large
node {baseDir}/scripts/embed.mjs --text "hello world" --dimensions 768 --output ./embedding.json
\`\`\`

## Parameters

- \`--text\`: Text to embed. Repeatable.
- \`--file\`: UTF-8 text file to embed. Repeatable.
- \`--model\`: \`openai/text-embedding-3-small\` (default) or \`openai/text-embedding-3-large\`
- \`--dimensions\`: Optional output dimension size when supported
- \`--output\`: Optional JSON output path

## Output

Prints JSON with \`model\`, \`usage\`, and \`items\`, where each item contains \`index\`, \`dimensions\`, and \`embedding\`.
`;
}

export function buildEmbeddingsScript(): string {
  return `import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values, positionals } = parseArgs({
  options: {
    text: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    model: { type: "string", default: "openai/text-embedding-3-small" },
    dimensions: { type: "string" },
    output: { type: "string" },
  },
  allowPositionals: true,
});

async function readApiKey() {
  // AI Gateway API key is injected via network policy header transform.
  // Return a placeholder — the real auth header is added at the firewall layer.
  return "injected-by-firewall";
}

const textInputs = [...(values.text ?? [])];
if (positionals.length > 0) {
  const positionalText = positionals.join(" ").trim();
  if (positionalText) textInputs.push(positionalText);
}

const fileInputs = [];
for (const filePath of values.file ?? []) {
  const resolved = path.resolve(filePath);
  const content = await readFile(resolved, "utf8");
  fileInputs.push(content);
}

const inputs = [...textInputs, ...fileInputs].map((value) => value.trim()).filter(Boolean);
if (inputs.length === 0) {
  console.error(
    "Usage: node embed.mjs --text \\"hello world\\" [--text TEXT] [--file PATH] [--model MODEL] [--dimensions N] [--output FILE]",
  );
  process.exit(1);
}

const apiKey = await readApiKey();

const dimensions = values.dimensions ? Number.parseInt(values.dimensions, 10) : undefined;
if (values.dimensions && (!Number.isFinite(dimensions) || dimensions <= 0)) {
  console.error("--dimensions must be a positive integer");
  process.exit(1);
}

const response = await fetch("https://ai-gateway.vercel.sh/v1/embeddings", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + apiKey,
  },
  body: JSON.stringify({
    model: values.model,
    input: inputs,
    ...(dimensions ? { dimensions } : {}),
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error("Embeddings request failed (" + response.status + "): " + errorText);
  process.exit(1);
}

const payload = await response.json();

const output = {
  model: payload.model,
  usage: payload.usage,
  items: (payload.data ?? []).map((item) => ({
    index: item.index,
    dimensions: Array.isArray(item.embedding) ? item.embedding.length : 0,
    embedding: item.embedding,
  })),
};

const json = JSON.stringify(output, null, 2);
if (values.output) {
  await writeFile(path.resolve(values.output), json + "\\n");
}
console.log(json);
`;
}

export function buildSemanticSearchSkill(): string {
  return `---
name: semantic-search
description: Build a local embedding index and run semantic search over files via Vercel AI Gateway embeddings
user-invocable: true
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      bins: ["node"]
      env: []
---

# Semantic Search (Vercel AI Gateway)

Create a local semantic index for project files, then query it with embeddings.

## Index a directory

\`\`\`bash
node {baseDir}/scripts/search.mjs index --dir .
\`\`\`

## Query the index

\`\`\`bash
node {baseDir}/scripts/search.mjs query --query "Where is the restore asset manifest built?"
\`\`\`

## More examples

\`\`\`bash
node {baseDir}/scripts/search.mjs index --dir ./src --db ./.semantic-index.json
node {baseDir}/scripts/search.mjs index --file README.md --file CLAUDE.md
node {baseDir}/scripts/search.mjs query --db ./.semantic-index.json --query "telegram webhook secret" --top 5
node {baseDir}/scripts/search.mjs query --query "OpenClaw package spec drift" --json
\`\`\`

## Commands

- \`index\`: Walk files, chunk text, call embeddings, and write a local JSON index
- \`query\`: Embed the query, compute cosine similarity, and return the best matches

## Parameters

- \`--dir\`: Directory to index recursively
- \`--file\`: Specific file(s) to index. Repeatable.
- \`--db\`: Index JSON path. Default: \`${OPENCLAW_STATE_DIR}/semantic-search/default-index.json\`
- \`--model\`: Embedding model. Default: \`openai/text-embedding-3-small\`
- \`--dimensions\`: Optional embedding dimensions
- \`--top\`: Number of query results to return. Default: \`5\`
- \`--json\`: Print query results as JSON
- \`--chunk-size\`: Character length per chunk. Default: \`1200\`
- \`--chunk-overlap\`: Character overlap between chunks. Default: \`200\`

## Output

- \`index\` prints a one-line summary with files and chunks indexed
- \`query\` prints ranked matches with score, path, and excerpt
`;
}

export function buildSemanticSearchScript(): string {
  return `import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const DEFAULT_DB_PATH = "${OPENCLAW_STATE_DIR}/semantic-search/default-index.json";

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".cpp", ".css", ".csv", ".go", ".html", ".java", ".js", ".json",
  ".jsx", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);

const { values, positionals } = parseArgs({
  options: {
    dir: { type: "string" },
    file: { type: "string", multiple: true },
    db: { type: "string", default: DEFAULT_DB_PATH },
    query: { type: "string" },
    top: { type: "string", default: "5" },
    model: { type: "string", default: "openai/text-embedding-3-small" },
    dimensions: { type: "string" },
    json: { type: "boolean", default: false },
    "chunk-size": { type: "string", default: "1200" },
    "chunk-overlap": { type: "string", default: "200" },
  },
  allowPositionals: true,
});

const command = positionals[0];
if (command !== "index" && command !== "query") {
  console.error("Usage: node search.mjs <index|query> [options]");
  process.exit(1);
}

async function readApiKey() {
  // AI Gateway API key is injected via network policy header transform.
  // Return a placeholder — the real auth header is added at the firewall layer.
  return "injected-by-firewall";
}

async function embedInputs(apiKey, model, inputs, dimensions) {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      input: inputs,
      ...(dimensions ? { dimensions } : {}),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error("Embeddings request failed (" + response.status + "): " + errorText);
  }
  const payload = await response.json();
  return payload.data.map((item) => item.embedding);
}

async function walkDir(rootDir) {
  const files = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.push(...(await walkDir(fullPath)));
      continue;
    }
    if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function chunkText(text, maxLength, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\\n\\n", end);
      const lineBreak = text.lastIndexOf("\\n", end);
      if (paragraphBreak > start + Math.floor(maxLength / 2)) {
        end = paragraphBreak;
      } else if (lineBreak > start + Math.floor(maxLength / 2)) {
        end = lineBreak;
      }
    }
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({ start, end, text: content });
    }
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function excerpt(text, maxLength = 220) {
  return text.replace(/\\s+/g, " ").trim().slice(0, maxLength);
}

const dbPath = path.resolve(values.db);
const model = values.model;
const top = Math.max(1, Number.parseInt(values.top, 10) || 5);
const chunkSize = Math.max(200, Number.parseInt(values["chunk-size"], 10) || 1200);
const chunkOverlap = Math.max(0, Number.parseInt(values["chunk-overlap"], 10) || 200);
const dimensions = values.dimensions ? Number.parseInt(values.dimensions, 10) : undefined;
if (values.dimensions && (!Number.isFinite(dimensions) || dimensions <= 0)) {
  console.error("--dimensions must be a positive integer");
  process.exit(1);
}

if (command === "index") {
  const apiKey = await readApiKey();
  const files = [];
  if (values.dir) {
    files.push(...(await walkDir(path.resolve(values.dir))));
  }
  for (const filePath of values.file ?? []) {
    const resolved = path.resolve(filePath);
    const fileStat = await stat(resolved);
    if (fileStat.isFile()) files.push(resolved);
  }

  const uniqueFiles = [...new Set(files)]
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => filePath !== dbPath)
    .sort();
  if (uniqueFiles.length === 0) {
    console.error("Index mode requires --dir PATH or at least one --file PATH");
    process.exit(1);
  }

  const records = [];
  for (const filePath of uniqueFiles) {
    const text = await readFile(filePath, "utf8");
    const chunks = chunkText(text, chunkSize, chunkOverlap);
    for (const chunk of chunks) {
      records.push({
        id: filePath + ":" + chunk.start + ":" + chunk.end,
        path: filePath,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
      });
    }
  }

  const embeddings = [];
  for (let i = 0; i < records.length; i += 16) {
    const batch = records.slice(i, i + 16);
    const vectors = await embedInputs(
      apiKey,
      model,
      batch.map((item) => item.text),
      dimensions,
    );
    embeddings.push(...vectors);
  }

  const index = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    model,
    dimensions: embeddings[0]?.length ?? null,
    rootDir: values.dir ? path.resolve(values.dir) : null,
    chunks: records.map((record, indexPos) => ({
      ...record,
      embedding: embeddings[indexPos],
    })),
  };

  await mkdir(path.dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(index, null, 2) + "\\n");
  console.log(
    "Indexed " + index.chunks.length + " chunks from " + uniqueFiles.length + " files into " + dbPath,
  );
  process.exit(0);
}

if (command === "query") {
  const query = (values.query ?? positionals.slice(1).join(" ")).trim();
  if (!query) {
    console.error("Query mode requires --query \\"...\\"");
    process.exit(1);
  }

  const apiKey = await readApiKey();
  const index = JSON.parse(await readFile(dbPath, "utf8"));
  if (!Array.isArray(index.chunks) || index.chunks.length === 0) {
    console.error("Index is empty: " + dbPath);
    process.exit(1);
  }

  if (
    dimensions &&
    index.dimensions &&
    Number.isFinite(index.dimensions) &&
    dimensions !== index.dimensions
  ) {
    console.error(
      "--dimensions must match the indexed dimensions (" + index.dimensions + ") when querying an existing index",
    );
    process.exit(1);
  }

  const queryDimensions = dimensions ?? index.dimensions ?? undefined;
  const [queryEmbedding] = await embedInputs(
    apiKey,
    index.model || model,
    [query],
    queryDimensions,
  );

  const matches = index.chunks
    .map((chunk) => ({
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
      path: chunk.path,
      start: chunk.start,
      end: chunk.end,
      text: chunk.text,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          query,
          dbPath,
          model: index.model || model,
          matches,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log("Query: " + query);
  console.log("Index: " + dbPath);
  console.log("");
  for (const [idx, match] of matches.entries()) {
    console.log(
      (idx + 1) + ". " + match.path + " [" + match.start + "-" + match.end + "] score=" + match.score.toFixed(4),
    );
    console.log("   " + excerpt(match.text));
    console.log("");
  }
}
`;
}

export function buildTranscriptionSkill(): string {
  return `---
name: transcription
description: Transcribe audio files via Vercel AI Gateway /v1/audio/transcriptions
user-invocable: true
metadata:
  openclaw:
    emoji: "🎙️"
    requires:
      bins: ["node"]
      env: []
---

# Audio Transcription (Vercel AI Gateway)

Transcribe audio files to text using OpenAI's Whisper model through Vercel AI Gateway.

## Run

\`\`\`bash
node {baseDir}/scripts/transcribe.mjs --file ./recording.mp3
\`\`\`

## More examples

\`\`\`bash
node {baseDir}/scripts/transcribe.mjs --file ./meeting.wav --language en
node {baseDir}/scripts/transcribe.mjs --file ./podcast.m4a --format verbose_json --output ./transcript.json
node {baseDir}/scripts/transcribe.mjs --file ./interview.mp3 --format srt --output ./captions.srt
\`\`\`

## Parameters

- \`--file\` (required): Path to an audio file (mp3, mp4, mpeg, mpga, m4a, wav, webm)
- \`--language\`: ISO-639-1 language code (e.g., en, es, fr). Optional — auto-detected if omitted.
- \`--format\`: Response format: json (default), text, srt, verbose_json, vtt
- \`--output\`: Output file path. If omitted, prints to stdout.
- \`--prompt\`: Optional text to guide the model's style or continue a previous segment.

## Output

Prints the transcription text to stdout, or writes to the specified output file.
`;
}

export function buildTranscriptionScript(): string {
  return `import { openAsBlob } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    language: { type: "string" },
    format: { type: "string", default: "json" },
    output: { type: "string" },
    prompt: { type: "string" },
  },
});

const filePath = values.file;
if (!filePath) {
  console.error("Usage: node transcribe.mjs --file ./audio.mp3 [--language LANG] [--format FORMAT] [--output FILE] [--prompt TEXT]");
  process.exit(1);
}

const VALID_FORMATS = new Set(["json", "text", "srt", "verbose_json", "vtt"]);
if (!VALID_FORMATS.has(values.format)) {
  console.error("--format must be one of: " + [...VALID_FORMATS].join(", "));
  process.exit(1);
}

const resolvedPath = path.resolve(filePath);
const audioBlob = await openAsBlob(resolvedPath);
const fileName = path.basename(resolvedPath);

async function readApiKey() {
  // AI Gateway API key is injected via network policy header transform.
  // Return a placeholder — the real auth header is added at the firewall layer.
  return "injected-by-firewall";
}

const apiKey = await readApiKey();

const formData = new FormData();
formData.append("file", audioBlob, fileName);
formData.append("model", "whisper-1");
formData.append("response_format", values.format);
if (values.language) {
  formData.append("language", values.language);
}
if (values.prompt) {
  formData.append("prompt", values.prompt);
}

const response = await fetch("https://ai-gateway.vercel.sh/v1/audio/transcriptions", {
  method: "POST",
  headers: { Authorization: "Bearer " + apiKey },
  body: formData,
});

if (!response.ok) {
  const errorText = await response.text();
  console.error("Transcription request failed (" + response.status + "): " + errorText);
  process.exit(1);
}

const result = await response.text();

if (values.output) {
  const outputPath = path.resolve(values.output);
  await writeFile(outputPath, result);
  console.log("Transcription written to " + outputPath);
} else {
  // For json/verbose_json, parse and pretty-print; for text/srt/vtt print as-is
  if (values.format === "json" || values.format === "verbose_json") {
    try {
      const parsed = JSON.parse(result);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(result);
    }
  } else {
    console.log(result);
  }
}
`;
}

export function buildReasoningSkill(): string {
  return `---
name: reasoning
description: Deep analysis using reasoning models via Vercel AI Gateway chat completions
user-invocable: true
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["node"]
      env: []
---

# Deep Reasoning (Vercel AI Gateway)

Invoke reasoning-capable models (o3, o4-mini, DeepSeek R1) through the AI Gateway
for complex analysis, multi-step logic, math, and code review.

## Run

\`\`\`bash
node {baseDir}/scripts/reason.mjs --prompt "Prove that the square root of 2 is irrational"
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/reason.mjs --prompt "Analyze this code for bugs" --model o4-mini
node {baseDir}/scripts/reason.mjs --prompt "Explain step by step" --reasoning-effort high
node {baseDir}/scripts/reason.mjs "What are the trade-offs of microservices?"
\`\`\`

## Parameters

- \`--prompt\` (required): The question or analysis task. Positional args are also accepted.
- \`--model\`: Reasoning model ID (default: o3)
- \`--reasoning-effort\`: Reasoning effort level — none, minimal, low, medium, high, or xhigh (default: medium)
- \`--output\`: Write the full response to a file instead of stdout.

## Output

Prints the model's answer to stdout. When the response includes a reasoning summary,
it is printed before the answer under a "Reasoning:" header.
`;
}

export function buildReasoningScript(): string {
  return `import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values, positionals } = parseArgs({
  options: {
    prompt: { type: "string" },
    model: { type: "string", default: "o3" },
    "reasoning-effort": { type: "string", default: "medium" },
    output: { type: "string" },
  },
  allowPositionals: true,
});

function normalizeModelId(model) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return "openai/o3";
  const aliases = new Map([
    ["o3", "openai/o3"],
    ["o4-mini", "openai/o4-mini"],
    ["gpt-4o", "openai/gpt-4o"],
    ["claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
    ["claude-haiku-4.5", "anthropic/claude-haiku-4.5"],
    ["gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["gemini-2.5-pro", "google/gemini-2.5-pro"],
    ["deepseek-v3.2-thinking", "deepseek/deepseek-v3.2-thinking"],
  ]);
  return aliases.get(trimmed) ?? trimmed;
}

const VALID_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const effort = values["reasoning-effort"];
if (!VALID_EFFORTS.has(effort)) {
  console.error("--reasoning-effort must be one of: " + [...VALID_EFFORTS].join(", "));
  process.exit(1);
}

const prompt = (values.prompt ?? positionals.join(" ")).trim();
if (!prompt) {
  console.error("Usage: node reason.mjs --prompt \\"your question\\" [--model MODEL] [--reasoning-effort none|minimal|low|medium|high|xhigh] [--output FILE]");
  process.exit(1);
}

async function readApiKey() {
  // AI Gateway API key is injected via network policy header transform.
  // Return a placeholder — the real auth header is added at the firewall layer.
  return "injected-by-firewall";
}

function extractText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("\\n")
      .trim();
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text.trim();
  if (typeof value.summary === "string") return value.summary.trim();
  if (typeof value.content === "string") return value.content.trim();
  return "";
}

function extractAnswer(message) {
  return extractText(message?.content);
}

function extractReasoningSummary(message, choice) {
  const legacy = [
    message?.reasoning_summary,
    message?.reasoning_content,
    choice?.reasoning_summary,
    message?.reasoning,
  ]
    .map((value) => extractText(value))
    .find(Boolean);
  if (legacy) return legacy;

  const details = Array.isArray(message?.reasoning_details) ? message.reasoning_details : [];
  const summaryBlocks = details
    .filter((detail) => detail && typeof detail === "object" && detail.type === "reasoning.summary")
    .map((detail) => extractText(detail))
    .filter(Boolean);
  if (summaryBlocks.length > 0) {
    return summaryBlocks.join("\\n");
  }

  const textBlocks = details
    .filter((detail) => detail && typeof detail === "object" && detail.type === "reasoning.text")
    .map((detail) => extractText(detail))
    .filter(Boolean);
  return textBlocks.join("\\n").trim();
}

const apiKey = await readApiKey();
const model = normalizeModelId(values.model);

const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({
    model,
    reasoning: { effort },
    messages: [{ role: "user", content: prompt }],
  }),
});

if (!response.ok) {
  const errorText = await response.text();
  console.error("Reasoning request failed (" + response.status + "): " + errorText);
  process.exit(1);
}

const data = await response.json();
const choice = data?.choices?.[0] ?? {};
const message = choice?.message ?? {};

const summary = extractReasoningSummary(message, choice);
const answer = extractAnswer(message);

const parts = [];
if (summary) parts.push("Reasoning:\\n" + summary + "\\n");
if (answer) parts.push(answer);
if (parts.length === 0) parts.push(JSON.stringify(data, null, 2));

const output = parts.join("\\n");

if (values.output) {
  const outputPath = path.resolve(values.output);
  await writeFile(outputPath, output + "\\n");
  console.log("Response written to " + outputPath);
} else {
  console.log(output);
}
`;
}

// ---------------------------------------------------------------------------
// Multi-model comparison skill
// ---------------------------------------------------------------------------

export function buildCompareSkill(): string {
  return `---
name: compare-models
description: Compare responses from multiple AI Gateway models side-by-side
user-invocable: true
metadata:
  openclaw:
    emoji: "⚖️"
    requires:
      bins: ["node"]
      env: []
---

# Multi-Model Comparison (Vercel AI Gateway)

Send the same prompt to multiple models through the AI Gateway and display
the responses side-by-side for easy comparison.

## Run

\`\`\`bash
node {baseDir}/scripts/compare.mjs --prompt "Explain quicksort in one paragraph"
\`\`\`

Flags:

\`\`\`bash
node {baseDir}/scripts/compare.mjs --prompt "Summarize the moon landing" --models openai/gpt-4o,anthropic/claude-sonnet-4.6
node {baseDir}/scripts/compare.mjs --prompt "Write a haiku about code" --models openai/gpt-4o,google/gemini-2.5-flash,anthropic/claude-sonnet-4.6
node {baseDir}/scripts/compare.mjs "What is the capital of France?" --output results.md
\`\`\`

## Parameters

- \`--prompt\` (required): The prompt to send to all models. Positional args are also accepted.
- \`--models\`: Comma-separated model IDs (default: openai/gpt-4o,anthropic/claude-sonnet-4.6)
- \`--output\`: Write the comparison to a file instead of stdout.

## Output

Prints each model's response under a header. When \`--output\` is set, writes a
Markdown file with one section per model.
`;
}

export function buildCompareScript(): string {
  return `import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const { values, positionals } = parseArgs({
  options: {
    prompt: { type: "string" },
    models: { type: "string", default: "openai/gpt-4o,anthropic/claude-sonnet-4.6" },
    output: { type: "string" },
  },
  allowPositionals: true,
});

const prompt = (values.prompt ?? positionals.join(" ")).trim();
if (!prompt) {
  console.error("Usage: node compare.mjs --prompt \\"your question\\" [--models model1,model2,...] [--output FILE]");
  process.exit(1);
}

function normalizeModelId(model) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return "";
  const aliases = new Map([
    ["gpt-4o", "openai/gpt-4o"],
    ["o3", "openai/o3"],
    ["o4-mini", "openai/o4-mini"],
    ["claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
    ["claude-haiku-4.5", "anthropic/claude-haiku-4.5"],
    ["gemini-2.5-flash", "google/gemini-2.5-flash"],
    ["gemini-2.5-pro", "google/gemini-2.5-pro"],
    ["deepseek-v3.2-thinking", "deepseek/deepseek-v3.2-thinking"],
  ]);
  return aliases.get(trimmed) ?? trimmed;
}

const models = [...new Set(values.models.split(",").map(normalizeModelId).filter(Boolean))];

if (models.length < 2) {
  console.error("--models must contain at least two comma-separated model IDs");
  process.exit(1);
}

async function readApiKey() {
  // AI Gateway API key is injected via network policy header transform.
  // Return a placeholder — the real auth header is added at the firewall layer.
  return "injected-by-firewall";
}

const apiKey = await readApiKey();

async function queryModel(model) {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { model, error: response.status + ": " + errorText };
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? "(no content)";
  return { model, content };
}

const results = await Promise.all(models.map(queryModel));

const sections = results.map((r) => {
  const header = "## " + r.model;
  if (r.error) return header + "\\n\\n**Error:** " + r.error;
  return header + "\\n\\n" + r.content;
});

const output = "# Model Comparison\\n\\n**Prompt:** " + prompt + "\\n\\n" + sections.join("\\n\\n---\\n\\n") + "\\n";

if (values.output) {
  const outputPath = path.resolve(values.output);
  await writeFile(outputPath, output + "\\n");
  console.log("MEDIA:" + outputPath);
} else {
  console.log(output);
}
`;
}

export function buildWorkerSandboxSkill(): string {
  return `---
name: worker-sandbox
description: Execute a bounded job in a fresh Vercel Sandbox created by the host app.
---

Use this when you need isolated compute, temporary filesystem state, extra packages, or a clean throwaway environment for a short task.

Prefer this skill when the user asks to:
- process one or more files or images in a separate sandbox
- install temporary packages or CLIs for a one-off job
- run code that should not change the main OpenClaw sandbox
- launch multiple independent child sandboxes; for more than one child sandbox, repeat this launcher once per job

Workflow:
1. Write a JSON request file that matches WorkerSandboxExecuteRequest.
2. Run: \`node ${OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH} /path/to/request.json --json-only\`
3. Parse the JSON response and inspect \`channelMedia\`, \`stdout\`, and \`stderr\`.
4. If you are replying in Telegram, Slack, WhatsApp, or Discord, send every returned \`channelMedia[].path\` with the \`message\` tool.

Rules:
- Put all input files under \`/workspace/\`.
- Put all files you want returned under \`/workspace/\` and list them in \`capturePaths\`.
- Default to \`vcpus: 1\` unless the job really needs more CPU.
- Keep jobs short and self-contained.
- Do not assume anything written in the child sandbox persists after the job finishes.

### WorkerSandboxExecuteRequest shape

\`\`\`json
{
  "task": "short-description",
  "files": [{ "path": "/workspace/input.txt", "contentBase64": "<base64>" }],
  "command": { "cmd": "bash", "args": ["-lc", "your command here"] },
  "capturePaths": ["/workspace/output.txt"],
  "vcpus": 1,
  "sandboxTimeoutMs": 300000
}
\`\`\`

### Example: round-trip one image through a child sandbox

\`\`\`json
{
  "task": "copy-image",
  "files": [{ "path": "/workspace/input.png", "contentBase64": "<base64>" }],
  "command": { "cmd": "bash", "args": ["-lc", "cp /workspace/input.png /workspace/output.png"] },
  "capturePaths": ["/workspace/output.png"],
  "vcpus": 1,
  "sandboxTimeoutMs": 300000
}
\`\`\`

### Response shape

\`\`\`json
{
  "ok": true,
  "task": "short-description",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "channelMedia": [
    {
      "sourcePath": "/workspace/output.txt",
      "path": "/workspace/openclaw-generated/worker/short-description-1-output.txt",
      "filename": "short-description-1-output.txt",
      "mimeType": "application/octet-stream"
    }
  ],
  "capturedFiles": [{ "path": "/workspace/output.txt" }]
}
\`\`\`

### Channel delivery (required on Telegram, Slack, WhatsApp, Discord)

When you are replying in Telegram, Slack, WhatsApp, or Discord, prefer the one-command form that sends every returned \`channelMedia[].path\` natively and still prints structured JSON:

\`\`\`bash
node ${OPENCLAW_WORKER_SANDBOX_SCRIPT_PATH} /workspace/request.json --json-only --send-channel-media --text "Done."
\`\`\`

This calls \`message send --media\` for each canonical \`channelMedia[].path\` automatically. You do not need to parse JSON and send each file manually.

If you need manual control, you can still iterate over \`channelMedia[].path\` from the JSON output:

\`\`\`bash
message send --media /workspace/openclaw-generated/worker/short-description-1-output.txt --text "Done."
\`\`\`
`;
}

export function buildWorkerSandboxScript(): string {
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const WORKER_MEDIA_DIR = "/workspace/openclaw-generated/worker";

function sanitizeMediaName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function inferMimeTypeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

async function materializeCapturedFiles(task, capturedFiles) {
  if (!capturedFiles || capturedFiles.length === 0) return [];
  try { await mkdir(WORKER_MEDIA_DIR, { recursive: true }); } catch { return []; }
  const channelMedia = [];
  for (const [index, file] of capturedFiles.entries()) {
    const base = sanitizeMediaName(path.basename(file.path));
    const filename = sanitizeMediaName(task) + "-" + (index + 1) + "-" + base;
    const outputPath = path.join(WORKER_MEDIA_DIR, filename);
    try {
      await writeFile(outputPath, Buffer.from(file.contentBase64, "base64"));
      channelMedia.push({
        sourcePath: file.path,
        path: outputPath,
        filename,
        mimeType: inferMimeTypeFromFilename(filename),
      });
    } catch { /* skip unwritable artifact */ }
  }
  return channelMedia;
}

function isCanonicalWorkerMediaPath(value) {
  return typeof value === "string" && value.startsWith("/workspace/openclaw-generated/worker/");
}

function sendChannelMedia(items, caption) {
  let first = true;
  for (const item of items) {
    if (!item || !isCanonicalWorkerMediaPath(item.path)) continue;
    const args = ["send", "--media", item.path];
    if (first && caption && caption.trim()) {
      args.push("--text", caption.trim());
    }
    const result = spawnSync("message", args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) {
      throw new Error("message send failed for " + item.path);
    }
    first = false;
  }
}

const { values, positionals } = parseArgs({
  options: {
    "json-only": { type: "boolean", default: false },
    "send-channel-media": { type: "boolean", default: false },
    text: { type: "string" },
  },
  allowPositionals: true,
});
const requestPath = positionals[0];
const jsonOnly = values["json-only"];
if (!requestPath) {
  console.error("Usage: execute.mjs <request-json-path> [--json-only] [--send-channel-media] [--text \\"caption\\"]");
  process.exit(1);
}

const gatewayToken = (await readFile("${OPENCLAW_GATEWAY_TOKEN_PATH}", "utf8")).trim();
const config = JSON.parse(await readFile("${OPENCLAW_CONFIG_PATH}", "utf8"));
const origin = config?.gateway?.controlUi?.allowedOrigins?.[0];
if (typeof origin !== "string" || origin.length === 0) {
  console.error("Could not resolve host origin from openclaw.json");
  process.exit(1);
}

const bearer = createHash("sha256")
  .update("worker-sandbox:v1\\0")
  .update(gatewayToken)
  .digest("hex");

const body = await readFile(requestPath, "utf8");

const response = await fetch(
  origin.replace(/\\/+$/, "") + "/api/internal/worker-sandboxes/execute",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + bearer,
    },
    body,
  },
);

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

const parsed = JSON.parse(text);
const channelMedia = await materializeCapturedFiles(parsed.task, parsed.capturedFiles);
const output = {
  ok: parsed.ok,
  task: parsed.task,
  exitCode: parsed.exitCode,
  stdout: parsed.stdout,
  stderr: parsed.stderr,
  channelMedia,
  capturedFiles: (parsed.capturedFiles ?? []).map((f) => ({ path: f.path })),
};
if (values["send-channel-media"]) {
  sendChannelMedia(channelMedia, values.text);
}
if (!jsonOnly) {
  if (parsed.stdout?.trim()) {
    console.log(parsed.stdout.trim());
  }
  for (const media of channelMedia) {
    console.log("MEDIA: " + media.path);
  }
}
console.log(JSON.stringify(output, null, 2));
`;
}

export function buildWorkerSandboxBatchSkill(): string {
  return `---
name: worker-sandbox-batch
description: Fan out multiple bounded jobs into fresh Vercel Sandboxes and collect structured results.
---

Use this when you need to run multiple isolated tasks in parallel — each in its own fresh sandbox.

1. Write a JSON request file that matches WorkerSandboxBatchExecuteRequest.
2. Run: \`node ${OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH} /path/to/request.json --json-only\`
3. Parse the JSON response from stdout.
4. For channel replies, prefer the one-command form: \`node ${OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH} /path/to/request.json --json-only --send-channel-media --text "Batch complete."\`

### WorkerSandboxBatchExecuteRequest shape

\`\`\`json
{
  "task": "parallel-summaries",
  "maxConcurrency": 2,
  "continueOnError": true,
  "passAiGatewayKey": true,
  "jobs": [
    {
      "id": "doc-1",
      "request": {
        "task": "summarize-doc-1",
        "files": [{ "path": "/workspace/input.txt", "contentBase64": "<base64>" }],
        "command": { "cmd": "bash", "args": ["-lc", "cat /workspace/input.txt > /workspace/output.txt"] },
        "capturePaths": ["/workspace/output.txt"],
        "vcpus": 1,
        "sandboxTimeoutMs": 300000
      }
    }
  ]
}
\`\`\`

### Options

- **maxConcurrency** (default 2, max 4): How many sandboxes run in parallel.
- **continueOnError** (default false): When false, stops scheduling after the first failure.
- **passAiGatewayKey** (default false): When true, injects AI_GATEWAY_API_KEY, OPENAI_API_KEY, and OPENAI_BASE_URL into each child sandbox so AI SDK calls work.

### Response shape

\`\`\`json
{
  "ok": true,
  "task": "parallel-summaries",
  "totalJobs": 1,
  "succeeded": 1,
  "failed": 0,
  "results": [
    {
      "id": "doc-1",
      "result": {
        "ok": true,
        "task": "summarize-doc-1",
        "exitCode": 0,
        "stdout": "",
        "stderr": "",
        "channelMedia": [
          {
            "sourcePath": "/workspace/output.txt",
            "path": "/workspace/openclaw-generated/worker/doc-1-summarize-doc-1-1-output.txt",
            "filename": "doc-1-summarize-doc-1-1-output.txt",
            "mimeType": "application/octet-stream"
          }
        ],
        "capturedFiles": [{ "path": "/workspace/output.txt" }]
      }
    }
  ]
}
\`\`\`

### Channel delivery (required on Telegram, Slack, WhatsApp, Discord)

For channel replies, prefer the one-command form that sends every \`results[].result.channelMedia[].path\` natively and still prints structured JSON:

\`\`\`bash
node ${OPENCLAW_WORKER_SANDBOX_BATCH_SCRIPT_PATH} /workspace/batch.json --json-only --send-channel-media --text "Batch complete."
\`\`\`

This calls \`message send --media\` for each canonical artifact across all successful jobs. You do not need to parse JSON and send each file manually.

### Scheduling with cron

\`\`\`bash
openclaw cron add \\
  --name "nightly-parallel-ai" \\
  --cron "0 3 * * *" \\
  --message "Run the worker-sandbox-batch skill with /workspace/nightly-batch.json and post the structured summary." \\
  --session isolated
\`\`\`
`;
}

export function buildWorkerSandboxBatchScript(): string {
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";

const WORKER_MEDIA_DIR = "/workspace/openclaw-generated/worker";

function sanitizeMediaName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function inferMimeTypeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

async function materializeCapturedFiles(task, capturedFiles) {
  if (!capturedFiles || capturedFiles.length === 0) return [];
  try { await mkdir(WORKER_MEDIA_DIR, { recursive: true }); } catch { return []; }
  const channelMedia = [];
  for (const [index, file] of capturedFiles.entries()) {
    const base = sanitizeMediaName(path.basename(file.path));
    const filename = sanitizeMediaName(task) + "-" + (index + 1) + "-" + base;
    const outputPath = path.join(WORKER_MEDIA_DIR, filename);
    try {
      await writeFile(outputPath, Buffer.from(file.contentBase64, "base64"));
      channelMedia.push({
        sourcePath: file.path,
        path: outputPath,
        filename,
        mimeType: inferMimeTypeFromFilename(filename),
      });
    } catch { /* skip unwritable artifact */ }
  }
  return channelMedia;
}

function isCanonicalWorkerMediaPath(value) {
  return typeof value === "string" && value.startsWith("/workspace/openclaw-generated/worker/");
}

function flattenBatchChannelMedia(payload) {
  const out = [];
  for (const entry of payload.results ?? []) {
    const media = entry?.result?.channelMedia;
    if (!Array.isArray(media)) continue;
    for (const item of media) {
      if (item && isCanonicalWorkerMediaPath(item.path)) out.push(item);
    }
  }
  return out;
}

function sendChannelMedia(items, caption) {
  let first = true;
  for (const item of items) {
    const args = ["send", "--media", item.path];
    if (first && caption && caption.trim()) {
      args.push("--text", caption.trim());
    }
    const result = spawnSync("message", args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0) {
      throw new Error("message send failed for " + item.path);
    }
    first = false;
  }
}

const { values, positionals } = parseArgs({
  options: {
    "json-only": { type: "boolean", default: false },
    "send-channel-media": { type: "boolean", default: false },
    text: { type: "string" },
  },
  allowPositionals: true,
});
const requestPath = positionals[0];
const jsonOnly = values["json-only"];
if (!requestPath) {
  console.error("Usage: execute-batch.mjs <request-json-path> [--json-only] [--send-channel-media] [--text \\"caption\\"]");
  process.exit(1);
}

const gatewayToken = (await readFile("${OPENCLAW_GATEWAY_TOKEN_PATH}", "utf8")).trim();
const config = JSON.parse(await readFile("${OPENCLAW_CONFIG_PATH}", "utf8"));
const origin = config?.gateway?.controlUi?.allowedOrigins?.[0];
if (typeof origin !== "string" || origin.length === 0) {
  console.error("Could not resolve host origin from openclaw.json");
  process.exit(1);
}

const bearer = createHash("sha256")
  .update("worker-sandbox:v1\\0")
  .update(gatewayToken)
  .digest("hex");

const body = await readFile(requestPath, "utf8");

const response = await fetch(
  origin.replace(/\\/+$/, "") + "/api/internal/worker-sandboxes/execute-batch",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + bearer,
    },
    body,
  },
);

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

const parsed = JSON.parse(text);
const results = [];
for (const entry of parsed.results ?? []) {
  const channelMedia = await materializeCapturedFiles(
    entry.id + "-" + entry.result.task,
    entry.result.capturedFiles,
  );
  if (!jsonOnly) {
    for (const media of channelMedia) {
      console.log("MEDIA: " + media.path);
    }
  }
  results.push({
    id: entry.id,
    result: {
      ok: entry.result.ok,
      task: entry.result.task,
      exitCode: entry.result.exitCode,
      stdout: entry.result.stdout,
      stderr: entry.result.stderr,
      channelMedia,
      capturedFiles: (entry.result.capturedFiles ?? []).map((f) => ({ path: f.path })),
    },
  });
}
const batchOutput = {
  ok: parsed.ok,
  task: parsed.task,
  totalJobs: parsed.totalJobs,
  succeeded: parsed.succeeded,
  failed: parsed.failed,
  results,
};
if (values["send-channel-media"]) {
  sendChannelMedia(flattenBatchChannelMedia(batchOutput), values.text);
}
console.log(JSON.stringify(batchOutput, null, 2));
`;
}

export function buildCronSkill(): string {
  return `---
name: cron
description: Schedule recurring tasks, reminders, and messages using OpenClaw cron
user-invocable: true
metadata:
  openclaw:
    emoji: "⏰"
---

# Cron Scheduling

Schedule tasks using the \\\`openclaw cron\\\` CLI. This is the primary way to create
recurring jobs that survive sandbox restarts.

## Quick examples

### Send a message every 30 minutes
\\\`\\\`\\\`bash
openclaw cron add --name "avatar-quote" --every 30m --message "Pick a random Avatar quote and share it." --announce --channel telegram --session isolated
\\\`\\\`\\\`

### Send a daily reminder at 9am UTC
\\\`\\\`\\\`bash
openclaw cron add --name "daily-standup" --cron "0 9 * * *" --message "Good morning! What are your priorities today?" --announce --channel telegram --session isolated
\\\`\\\`\\\`

### One-shot reminder
\\\`\\\`\\\`bash
openclaw cron add --name "deploy-check" --at "+20m" --message "Check the deploy status." --announce --channel telegram --session isolated
\\\`\\\`\\\`

### Every 5 minutes
\\\`\\\`\\\`bash
openclaw cron add --name "heartbeat" --every 5m --message "Quick status check." --announce --channel telegram --session isolated
\\\`\\\`\\\`

## Key flags

| Flag | Description |
|------|-------------|
| \\\`--name <name>\\\` | Job name (required) |
| \\\`--every <duration>\\\` | Recurring interval (e.g. \\\`5m\\\`, \\\`1h\\\`, \\\`30m\\\`) |
| \\\`--cron <expr>\\\` | Cron expression (e.g. \\\`0 9 * * 1-5\\\`) |
| \\\`--at <when>\\\` | One-shot at ISO time or \\\`+duration\\\` (e.g. \\\`+20m\\\`) |
| \\\`--message <text>\\\` | What the agent should do when the job fires |
| \\\`--announce\\\` | Deliver the result to a chat channel |
| \\\`--channel <ch>\\\` | Which channel to deliver to (\\\`telegram\\\`, \\\`slack\\\`, \\\`discord\\\`) |
| \\\`--session isolated\\\` | Run in an isolated session (recommended) |
| \\\`--json\\\` | Output result as JSON |

## Managing jobs

\\\`\\\`\\\`bash
openclaw cron list                    # List all jobs
openclaw cron list --json             # List as JSON
openclaw cron run <jobId>             # Trigger a job now
openclaw cron runs <jobId>            # Show run history
openclaw cron disable <jobId>         # Disable a job
openclaw cron enable <jobId>          # Enable a job
openclaw cron rm <jobId>              # Delete a job
openclaw cron status                  # Scheduler status
\\\`\\\`\\\`

## Important notes

- The \\\`--announce\\\` flag is required for the job to deliver results to a chat.
- Without \\\`--channel\\\`, delivery goes to the last active channel.
- Jobs survive sandbox restarts via snapshot persistence.
- The host watchdog checks every 5 minutes and wakes the sandbox if a job is due.
- Minimum interval for \\\`--every\\\` is 1 minute.
`;
}
