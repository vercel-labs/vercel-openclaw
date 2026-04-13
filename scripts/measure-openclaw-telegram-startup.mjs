#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    port: { type: "string", default: "3010" },
    "tg-port": { type: "string", default: "8787" },
    timeout: { type: "string", default: "60" },
    "temp-dir": { type: "string" },
    label: { type: "string" },
    "skip-prewarm": { type: "boolean", default: false },
    "disable-exec-approvals": { type: "boolean", default: false },
    "agent-runtime": { type: "string" },
    out: { type: "string" },
    "json-only": { type: "boolean", default: false },
  },
});

const repo = values.repo?.trim();
if (!repo) {
  console.error("error: --repo is required");
  process.exit(2);
}

const port = Number.parseInt(values.port, 10);
const tgPort = Number.parseInt(values["tg-port"], 10);
const timeoutMs = Number.parseInt(values.timeout, 10) * 1000;
const label = values.label?.trim() || path.basename(repo);
const jsonOnly = values["json-only"];
const outPath = values.out?.trim() || null;

function log(message) {
  if (!jsonOnly) {
    process.stderr.write(`[measure-openclaw] ${message}\n`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatus(url, init) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(2_000),
    });
    const text = await response.text();
    return {
      ok: true,
      status: response.status,
      durationMs: Date.now() - startedAt,
      body: text,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const requestedTempDir = values["temp-dir"]?.trim() || null;
  const tempRoot = requestedTempDir
    ? path.resolve(requestedTempDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-"));
  if (requestedTempDir) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  const stateDir = path.join(tempRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  const logPath = path.join(tempRoot, "gateway.log");

  const config = {
    gateway: {
      mode: "local",
      auth: { mode: "token" },
      controlUi: {
        allowInsecureAuth: true,
        dangerouslyDisableDeviceAuth: true,
        allowedOrigins: [`http://127.0.0.1:${port}`],
      },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    update: { checkOnStart: false },
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-4o-mini",
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-placeholder",
          api: "openai-completions",
          models: [{ id: "gpt-4o-mini", name: "GPT-4o Mini" }],
        },
      },
    },
    commands: { ownerAllowFrom: ["*"] },
    channels: {
      telegram: {
        enabled: true,
        botToken: "123456:fake-token",
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        webhookPort: tgPort,
        webhookHost: "127.0.0.1",
        webhookPath: "/telegram-webhook",
        webhookUrl: "https://example.test/api/channels/telegram/webhook",
        webhookSecret: "probe-secret",
        ...(values["disable-exec-approvals"] ? { execApprovals: { enabled: false } } : {}),
      },
    },
  };

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  log(`tempRoot=${tempRoot}`);
  log(`configPath=${configPath}`);
  log(`logPath=${logPath}`);

  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENAI_API_KEY: "sk-placeholder",
    AI_GATEWAY_API_KEY: "sk-placeholder",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENCLAW_GATEWAY_TOKEN: "local-test-token",
    OPENCLAW_SKIP_UPDATE_CHECK: "1",
    OPENCLAW_ALLOW_UNCONFIGURED: "1",
  };

  if (values["skip-prewarm"]) {
    env.OPENCLAW_AGENT_RUNTIME = values["agent-runtime"]?.trim() || "none";
  } else if (values["agent-runtime"]?.trim()) {
    env.OPENCLAW_AGENT_RUNTIME = values["agent-runtime"].trim();
  }

  const entry = path.join(repo, "openclaw.mjs");
  const logFileHandle = await fs.open(logPath, "w");
  const child = spawn("node", [entry, "gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logFileHandle.createWriteStream());
  child.stderr.pipe(logFileHandle.createWriteStream());

  const startedAt = Date.now();
  const timeline = [];
  let webReadyAt = null;
  let telegramReadyAt = null;
  let lastWeb = null;
  let lastTelegram = null;

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const elapsedMs = Date.now() - startedAt;
      const web = await fetchStatus(`http://127.0.0.1:${port}/`);
      const telegram = await fetchStatus(`http://127.0.0.1:${tgPort}/telegram-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "probe-invalid-secret",
        },
        body: "{}",
      });

      lastWeb = web;
      lastTelegram = telegram;

      timeline.push({
        elapsedMs,
        webStatus: web.status,
        webOk: web.ok,
        telegramStatus: telegram.status,
        telegramOk: telegram.ok,
        telegramError: telegram.ok ? null : telegram.error,
      });

      if (webReadyAt == null && web.status === 200) {
        webReadyAt = elapsedMs;
      }
      if (telegramReadyAt == null && telegram.status === 401) {
        telegramReadyAt = elapsedMs;
        break;
      }

      await sleep(250);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await logFileHandle.close();
  }

  const logText = await fs.readFile(logPath, "utf8").catch(() => "");
  const result = {
    label,
    repo,
    port,
    tgPort,
    stateDir,
    configPath,
    durationMs: Date.now() - startedAt,
    webReadyAt,
    telegramReadyAt,
    deltaMs:
      webReadyAt != null && telegramReadyAt != null
        ? telegramReadyAt - webReadyAt
        : null,
    usedAgentRuntime: env.OPENCLAW_AGENT_RUNTIME ?? null,
    execApprovalsDisabled: values["disable-exec-approvals"],
    timeline: timeline.slice(-40),
    lastWeb,
    lastTelegram,
    logTail: logText.split(/\r?\n/).slice(-120),
  };

  if (outPath) {
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(telegramReadyAt != null ? 0 : 1);
}

void main();
