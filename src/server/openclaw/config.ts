const OPENCLAW_PORT = 3000;

export const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
export const OPENCLAW_STATE_DIR = "/home/vercel-sandbox/.openclaw";
export const OPENCLAW_CONFIG_PATH = `${OPENCLAW_STATE_DIR}/openclaw.json`;
export const OPENCLAW_GATEWAY_TOKEN_PATH = `${OPENCLAW_STATE_DIR}/.gateway-token`;
export const OPENCLAW_AI_GATEWAY_API_KEY_PATH = `${OPENCLAW_STATE_DIR}/.ai-gateway-api-key`;
export const OPENCLAW_FORCE_PAIR_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/.force-pair.mjs`;
export const OPENCLAW_IMAGE_GEN_SKILL_PATH = `${OPENCLAW_STATE_DIR}/skills/openai-image-gen/SKILL.md`;
export const OPENCLAW_IMAGE_GEN_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/skills/openai-image-gen/scripts/gen.mjs`;
export const OPENCLAW_LOG_FILE = "/tmp/openclaw.log";
export const OPENCLAW_STARTUP_SCRIPT_PATH = "/vercel/sandbox/.on-restore.sh";

export function buildGatewayConfig(
  apiKey?: string,
  proxyOrigin?: string,
): string {
  const controlUi: Record<string, unknown> = {
    allowInsecureAuth: true,
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

  if (apiKey) {
    config.agents = {
      defaults: {
        model: {
          primary: "vercel-ai-gateway/openai/gpt-5.3-chat",
          fallbacks: [
            "vercel-ai-gateway/anthropic/claude-haiku-4.5",
            "vercel-ai-gateway/google/gemini-2.5-flash",
          ],
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
            { id: "gpt-4o", name: "GPT-4o", input: ["text", "image"] },
            { id: "gpt-image-1", name: "GPT Image 1" },
            { id: "dall-e-3", name: "DALL-E 3" },
            { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
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
pkill -f "openclaw gateway" || true
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
      const match = url.match(/^data:image\\\\/[^;]+;base64,(.+)$/);
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
