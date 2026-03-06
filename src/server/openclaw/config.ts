const OPENCLAW_PORT = 3000;

export const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
export const OPENCLAW_STATE_DIR = "/home/vercel-sandbox/.openclaw";
export const OPENCLAW_CONFIG_PATH = `${OPENCLAW_STATE_DIR}/openclaw.json`;
export const OPENCLAW_GATEWAY_TOKEN_PATH = `${OPENCLAW_STATE_DIR}/.gateway-token`;
export const OPENCLAW_AI_GATEWAY_API_KEY_PATH = `${OPENCLAW_STATE_DIR}/.ai-gateway-api-key`;
export const OPENCLAW_FORCE_PAIR_SCRIPT_PATH = `${OPENCLAW_STATE_DIR}/.force-pair.mjs`;
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
          ],
        },
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
