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
export const OPENCLAW_TELEGRAM_BOT_TOKEN_PATH = `${OPENCLAW_STATE_DIR}/.telegram-bot-token`;
export const OPENCLAW_TELEGRAM_WEBHOOK_PORT = 8787;
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

export function buildGatewayConfig(
  apiKey?: string,
  proxyOrigin?: string,
  telegramBotToken?: string,
  slackCredentials?: { botToken: string; signingSecret: string },
): string {
  const controlUi: Record<string, unknown> = {
    allowInsecureAuth: readBooleanEnv("OPENCLAW_ALLOW_INSECURE_AUTH", false),
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
        primary: "vercel-ai-gateway/openai/gpt-5.3-chat",
        fallbacks: [
          "vercel-ai-gateway/anthropic/claude-haiku-4.5",
          "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
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
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        apiKey: "sk-placeholder",
        api: "openai-completions",
        models: [
          { id: "gpt-image-1", name: "GPT Image 1" },
          { id: "dall-e-3", name: "DALL-E 3" },
          { id: "gpt-4o", name: "GPT-4o", input: ["text", "image"] },
          { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
          { id: "text-embedding-3-small", name: "Text Embedding 3 Small" },
          { id: "text-embedding-3-large", name: "Text Embedding 3 Large" },
        ],
      },
    },
  };
  config.tools = {
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

  // OpenClaw reads the bot token from its config file on the sandbox filesystem.
  // The token is also written to a separate file (OPENCLAW_TELEGRAM_BOT_TOKEN_PATH)
  // for the restore deleteWebhook script.  Neither file is logged or exposed
  // via any API — they live only on the sandbox's restricted filesystem,
  // consistent with how the gateway token and AI Gateway key are stored.
  if (telegramBotToken) {
    config.channels = {
      telegram: {
        enabled: true,
        botToken: telegramBotToken,
        // "open" allows any Telegram user to DM the bot.  This matches the
        // old project's behavior and the admin-controlled webhook setup.
        dmPolicy: "open",
        allowFrom: ["*"],
        webhookPort: OPENCLAW_TELEGRAM_WEBHOOK_PORT,
      },
    };
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
      webhookPath: "/slack/events",
    };
    config.channels = channels;
  }

  return JSON.stringify(config);
}

export function buildForcePairScript(): string {
  return `import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const stateDir = process.argv[2];
const identityDir = path.join(stateDir, "identity");
const identityPath = path.join(identityDir, "device.json");

let identity;
try {
  identity = JSON.parse(await fs.readFile(identityPath, "utf8"));
} catch {
  await fs.mkdir(identityDir, { recursive: true });
  const kp = crypto.generateKeyPairSync("ed25519");
  identity = {
    publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
    createdAtMs: Date.now(),
  };
  await fs.writeFile(identityPath, JSON.stringify(identity, null, 2) + "\\n", { mode: 0o600 });
}

const publicKeyPem = identity.publicKeyPem;
if (typeof publicKeyPem !== "string") process.exit(0);

const pubKey = crypto.createPublicKey(publicKeyPem);
const spkiDer = pubKey.export({ type: "spki", format: "der" });
const prefix = Buffer.from("302a300506032b6570032100", "hex");
if (
  spkiDer.length !== prefix.length + 32 ||
  !spkiDer.subarray(0, prefix.length).equals(prefix)
) {
  process.exit(0);
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
let paired = {};
try { paired = JSON.parse(await fs.readFile(pairedPath, "utf8")); } catch {}

paired[deviceId] = {
  deviceId,
  publicKey: publicKeyRawBase64Url,
  approvedAtMs: Date.now(),
};

await fs.writeFile(pairedPath, JSON.stringify(paired, null, 2) + "\\n", { mode: 0o600 });
console.log("Force-paired device identity");
`;
}

export function buildStartupScript(): string {
  return `#!/bin/bash
set -euo pipefail
mkdir -p "${OPENCLAW_STATE_DIR}/devices"
rm -f "${OPENCLAW_STATE_DIR}/devices/paired.json" "${OPENCLAW_STATE_DIR}/devices/pending.json"
gateway_token="$(cat "${OPENCLAW_GATEWAY_TOKEN_PATH}")"
if [ -z "$gateway_token" ]; then
  echo "Gateway token file is empty" >&2
  exit 1
fi
if [ -z "\${AI_GATEWAY_API_KEY:-}" ]; then
  ai_gateway_api_key="$(cat "${OPENCLAW_AI_GATEWAY_API_KEY_PATH}" 2>/dev/null || true)"
else
  ai_gateway_api_key="$AI_GATEWAY_API_KEY"
fi
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"
if [ -n "$ai_gateway_api_key" ]; then
  export AI_GATEWAY_API_KEY="$ai_gateway_api_key"
  export OPENAI_API_KEY="$ai_gateway_api_key"
  export OPENAI_BASE_URL="https://ai-gateway.vercel.sh/v1"
fi
tg_token="$(cat "${OPENCLAW_TELEGRAM_BOT_TOKEN_PATH}" 2>/dev/null || true)"
if [ -n "$tg_token" ]; then
  curl -sf "https://api.telegram.org/bot\${tg_token}/deleteWebhook?drop_pending_updates=false" >/dev/null 2>&1 || true
fi
pkill -f "openclaw.gateway" || true
setsid env OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" OPENCLAW_GATEWAY_TOKEN="$gateway_token" AI_GATEWAY_API_KEY="$ai_gateway_api_key" OPENAI_API_KEY="$ai_gateway_api_key" OPENAI_BASE_URL="https://ai-gateway.vercel.sh/v1" ${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT} --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &
_learning_log=/tmp/shell-commands-for-learning.log
touch "$_learning_log"
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
if [ -n "\${AI_GATEWAY_API_KEY:-}" ]; then
  ai_gateway_api_key="\$AI_GATEWAY_API_KEY"
  (umask 077; printf '%s' "\$ai_gateway_api_key" > "${OPENCLAW_AI_GATEWAY_API_KEY_PATH}")
else
  ai_gateway_api_key="$(cat "${OPENCLAW_AI_GATEWAY_API_KEY_PATH}" 2>/dev/null || true)"
fi
ai_gateway_base_url="https://ai-gateway.vercel.sh/v1"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="\$gateway_token"
if [ -n "$ai_gateway_api_key" ]; then
  export AI_GATEWAY_API_KEY="$ai_gateway_api_key"
  export OPENAI_API_KEY="$ai_gateway_api_key"
  export OPENAI_BASE_URL="$ai_gateway_base_url"
fi
# Start gateway immediately — no pkill needed (snapshots have no running
# processes) and no Telegram webhook delete needed before boot.
echo '{"event":"fast_restore.start_gateway"}' >&2
if [ -x "${BUN_BIN}" ]; then
  setsid ${BUN_BIN} ${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT} --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &
else
  setsid ${OPENCLAW_BIN} gateway --port ${OPENCLAW_PORT} --bind loopback >> ${OPENCLAW_LOG_FILE} 2>&1 &
fi
# Launch-only: exit immediately after backgrounding the gateway.
# Readiness is detected by host-side HTTP probing (probeGatewayReady),
# which avoids the ~6s runCommand API round-trip overhead.
# Deferred work (telegram webhook delete) fires in background.
tg_token="$(cat "${OPENCLAW_TELEGRAM_BOT_TOKEN_PATH}" 2>/dev/null || true)"
if [ -n "\$tg_token" ]; then
  curl -sf --max-time 5 "https://api.telegram.org/bot\${tg_token}/deleteWebhook?drop_pending_updates=false" >/dev/null 2>&1 &
fi
echo '{"event":"fast_restore.complete"}' >&2
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
      env: ["AI_GATEWAY_API_KEY"]
    primaryEnv: AI_GATEWAY_API_KEY
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

The script saves PNG images to disk and prints their file paths (one per line).

**IMPORTANT:** To display images inline, output a \`MEDIA:\` line with the absolute path.
Do NOT use markdown image syntax. Example:

\`\`\`
MEDIA:/home/vercel-sandbox/.openclaw/workspace/generated-image.png
\`\`\`

For Telegram/Discord channels, use \`message send --media /path/to/image.png\` instead.
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

const apiKey = (await readFile("${OPENCLAW_AI_GATEWAY_API_KEY_PATH}", "utf8")).trim();
if (!apiKey) {
  console.error("No AI Gateway API key found");
  process.exit(1);
}

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
for (const f of saved) console.log(f);
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
      env: ["AI_GATEWAY_API_KEY"]
    primaryEnv: AI_GATEWAY_API_KEY
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

const apiKey = (await readFile("${OPENCLAW_AI_GATEWAY_API_KEY_PATH}", "utf8")).trim();
if (!apiKey) {
  console.error("No AI Gateway API key found");
  process.exit(1);
}

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
      env: ["AI_GATEWAY_API_KEY"]
    primaryEnv: AI_GATEWAY_API_KEY
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

const apiKey = (await readFile("${OPENCLAW_AI_GATEWAY_API_KEY_PATH}", "utf8")).trim();
if (!apiKey) {
  console.error("No AI Gateway API key found");
  process.exit(1);
}

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
      env: ["AI_GATEWAY_API_KEY"]
    primaryEnv: AI_GATEWAY_API_KEY
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

const apiKey = (await readFile("${OPENCLAW_AI_GATEWAY_API_KEY_PATH}", "utf8")).trim();
if (!apiKey) {
  console.error("No AI Gateway API key found");
  process.exit(1);
}

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
      env: ["AI_GATEWAY_API_KEY"]
    primaryEnv: AI_GATEWAY_API_KEY
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

const apiKey = (await readFile("${OPENCLAW_AI_GATEWAY_API_KEY_PATH}", "utf8")).trim();
if (!apiKey) {
  console.error("No AI Gateway API key found");
  process.exit(1);
}

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
