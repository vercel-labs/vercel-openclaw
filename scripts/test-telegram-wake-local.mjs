#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3005" },
    timeout: { type: "string", default: "180" },
    "request-timeout": { type: "string", default: "30" },
    "admin-secret": { type: "string" },
    "instance-id": { type: "string" },
    "keep-processes": { type: "boolean", default: false },
    "json-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`test-telegram-wake-local — local Telegram wake test via vgrok

USAGE
  node scripts/test-telegram-wake-local.mjs [options]

OPTIONS
  --port             Local Next.js port to use (default: 3005)
  --timeout          Overall wake test timeout in seconds (default: 180)
  --request-timeout  Per-request timeout in seconds (default: 30)
  --admin-secret     Admin bearer token; defaults to ADMIN_SECRET from .env.agent or .env.local
  --instance-id      Override OPENCLAW_INSTANCE_ID for the local run
  --keep-processes   Leave next dev and vgrok running after the test
  --json-only        Suppress human-readable logs; emit JSON summary only
  --help             Show this message

FLOW
  1. Backup and sanitize .env.local so local Next.js does not think it is running on Vercel
  2. Start next dev on a dedicated port
  3. Start vgrok for that port and capture the public URL
  4. Run scripts/test-telegram-wake.mjs against the vgrok URL
  5. Stop local processes and restore the original .env.local
`);
  process.exit(0);
}

const port = Number.parseInt(values.port, 10);
if (!Number.isFinite(port) || port < 1) {
  process.stderr.write("error: --port must be a positive integer\n");
  process.exit(2);
}

const timeoutSec = Number.parseInt(values.timeout, 10);
if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
  process.stderr.write("error: --timeout must be a positive integer\n");
  process.exit(2);
}

const requestTimeoutSec = Number.parseInt(values["request-timeout"], 10);
if (!Number.isFinite(requestTimeoutSec) || requestTimeoutSec < 1) {
  process.stderr.write("error: --request-timeout must be a positive integer\n");
  process.exit(2);
}

const jsonOnly = values["json-only"];
const keepProcesses = values["keep-processes"];

function log(message) {
  if (!jsonOnly) {
    process.stderr.write(`[telegram-wake-local] ${message}\n`);
  }
}

function parseEnvFile(text) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result.set(match[1], value);
  }
  return result;
}

function serializeEnvFile(map) {
  return Array.from(map.entries())
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n") + "\n";
}

async function readEnvFileIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function waitForExit(child, signal = "SIGTERM", graceMs = 10_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const done = () => resolve();
    child.once("exit", done);
    child.kill(signal);
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, graceMs).unref();
  });
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function waitForLocalServer(portNumber, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server did not respond";

  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(
        `http://127.0.0.1:${portNumber}/api/health`,
        5_000,
      );
      if (result.ok) {
        return;
      }
      lastError = `HTTP ${result.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`local server did not become ready on port ${portNumber}: ${lastError}`);
}

async function readLocalStatus(portNumber, adminSecret) {
  const response = await fetch(`http://127.0.0.1:${portNumber}/api/status`, {
    headers: {
      authorization: `Bearer ${adminSecret}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function waitForServerNotInSetup(portNumber, adminSecret, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPhase = null;

  while (Date.now() < deadline) {
    const result = await readLocalStatus(portNumber, adminSecret);
    if (result.ok && result.body && typeof result.body === "object") {
      const body = result.body;
      if (body.status !== "setup" && body.status !== "creating") {
        return body;
      }

      const phase = body.setupProgress?.phase ?? body.status;
      const preview = body.setupProgress?.preview ?? "";
      const formatted = preview ? `${phase}: ${preview}` : String(phase);
      if (formatted !== lastPhase) {
        log(`local setup progress: ${formatted}`);
        lastPhase = formatted;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  throw new Error("local server stayed in creating/setup too long");
}

async function waitForVgrokUrl(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error("timed out waiting for vgrok to print a public URL"));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        log(`[vgrok] ${line}`);
        const match = line.match(/Ready at (https:\/\/\S+)/);
        if (match?.[1]) {
          clearTimeout(deadline);
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          resolve(match[1]);
          return;
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      reject(new Error(`vgrok exited before producing a URL (code ${code ?? "unknown"})`));
    });
  });
}

function attachPrefixedLogs(child, prefix) {
  const write = (streamName, chunk) => {
    if (jsonOnly) return;
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      process.stderr.write(`[${prefix}:${streamName}] ${line}\n`);
    }
  };
  child.stdout?.on("data", (chunk) => write("out", chunk));
  child.stderr?.on("data", (chunk) => write("err", chunk));
}

const envLocalPath = path.join(repoRoot, ".env.local");
const backupEnvLocalPath = path.join(repoRoot, ".env.local.vgrok-test.backup");
const envAgentPath = path.join(repoRoot, ".env.agent");

async function main() {
  const startedAt = Date.now();
  const backupEnvLocal = await readEnvFileIfPresent(backupEnvLocalPath);
  const currentEnvLocal = await readEnvFileIfPresent(envLocalPath);
  const originalEnvLocal = backupEnvLocal ?? currentEnvLocal;
  const agentEnvText = (await readEnvFileIfPresent(envAgentPath)) ?? "";
  const agentEnv = parseEnvFile(agentEnvText);
  const originalEnv = parseEnvFile(originalEnvLocal ?? "");

  const adminSecret =
    values["admin-secret"]?.trim() ||
    agentEnv.get("ADMIN_SECRET") ||
    originalEnv.get("ADMIN_SECRET") ||
    process.env.ADMIN_SECRET ||
    "";

  if (!adminSecret) {
    throw new Error("ADMIN_SECRET is required. Set it in .env.agent, .env.local, or pass --admin-secret.");
  }

  const localInstanceId =
    values["instance-id"]?.trim() ||
    `local-vgrok-${Date.now().toString(36)}`;

  const sanitizedEnv = new Map();
  for (const [key, value] of originalEnv.entries()) {
    if (
      key === "VERCEL" ||
      key === "VERCEL_ENV" ||
      key === "VERCEL_URL" ||
      key === "VERCEL_BRANCH_URL" ||
      key === "VERCEL_PROJECT_PRODUCTION_URL" ||
      key === "VERCEL_TARGET_ENV" ||
      key === "NEXT_PUBLIC_APP_URL"
    ) {
      continue;
    }
    sanitizedEnv.set(key, value);
  }

  sanitizedEnv.set("ADMIN_SECRET", adminSecret);
  sanitizedEnv.set("OPENCLAW_INSTANCE_ID", localInstanceId);
  sanitizedEnv.set("VERCEL_AUTH_MODE", "admin-secret");

  const hasSandboxCredential =
    sanitizedEnv.has("VERCEL_OIDC_TOKEN") ||
    sanitizedEnv.has("AI_GATEWAY_API_KEY") ||
    process.env.VERCEL_OIDC_TOKEN ||
    process.env.AI_GATEWAY_API_KEY;

  if (!hasSandboxCredential) {
    throw new Error(
      "No Vercel Sandbox credential found. Preserve VERCEL_OIDC_TOKEN or set AI_GATEWAY_API_KEY before running the local wake test.",
    );
  }

  let devChild = null;
  let vgrokChild = null;
  let tunnelUrl = null;
  let wakeResult = null;

  try {
    if (originalEnvLocal !== null) {
      await fs.writeFile(backupEnvLocalPath, originalEnvLocal, "utf8");
    }
    await fs.writeFile(envLocalPath, serializeEnvFile(sanitizedEnv), "utf8");
    log(`sanitized .env.local written with OPENCLAW_INSTANCE_ID=${localInstanceId}`);

    devChild = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_SECRET: adminSecret,
        OPENCLAW_INSTANCE_ID: localInstanceId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    attachPrefixedLogs(devChild, "next");

    await waitForLocalServer(port, 120_000);
    log(`local server is ready on port ${port}`);
    await waitForServerNotInSetup(port, adminSecret, 20 * 60_000);
    log("local server is past initial setup");

    vgrokChild = spawn("npx", ["@styfle/vgrok", String(port)], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    tunnelUrl = await waitForVgrokUrl(vgrokChild, 90_000);
    log(`vgrok tunnel ready at ${tunnelUrl}`);

    const wakeChild = spawn(
      "node",
      [
        path.join(repoRoot, "scripts/test-telegram-wake.mjs"),
        "--base-url",
        tunnelUrl,
        "--admin-secret",
        adminSecret,
        "--timeout",
        String(timeoutSec),
        "--request-timeout",
        String(requestTimeoutSec),
        ...(jsonOnly ? ["--json-only"] : []),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    wakeChild.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!jsonOnly) process.stdout.write(chunk);
    });
    wakeChild.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!jsonOnly) process.stderr.write(chunk);
    });

    const exitCode = await new Promise((resolve, reject) => {
      wakeChild.once("error", reject);
      wakeChild.once("exit", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(
        `test-telegram-wake.mjs exited with code ${exitCode}\n${stderr || stdout}`.trim(),
      );
    }

    const jsonMatch = stdout.match(/\{[\s\S]*\}\s*$/);
    if (jsonMatch?.[0]) {
      wakeResult = JSON.parse(jsonMatch[0]);
    }

    const summary = {
      schemaVersion: 1,
      type: "telegram-wake-local-test",
      passed: wakeResult?.passed ?? true,
      generatedAt: new Date().toISOString(),
      port,
      tunnelUrl,
      openclawInstanceId: localInstanceId,
      elapsedMs: Date.now() - startedAt,
      wake: wakeResult,
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stderr.write(`\n[telegram-wake-local] tunnel: ${tunnelUrl}\n`);
      process.stderr.write(`[telegram-wake-local] instance: ${localInstanceId}\n`);
      process.stderr.write(`[telegram-wake-local] elapsed: ${summary.elapsedMs}ms\n`);
    }

    return 0;
  } finally {
    if (!keepProcesses) {
      if (vgrokChild) await waitForExit(vgrokChild);
      if (devChild) await waitForExit(devChild);
    }

    if (originalEnvLocal !== null) {
      await fs.writeFile(envLocalPath, originalEnvLocal, "utf8");
      await fs.rm(backupEnvLocalPath, { force: true });
    } else {
      await fs.rm(envLocalPath, { force: true });
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(1);
  });
