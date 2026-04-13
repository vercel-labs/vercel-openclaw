#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
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
    "openclaw-package-spec": { type: "string" },
    "artifacts-dir": { type: "string" },
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
  --openclaw-package-spec  Override OPENCLAW_PACKAGE_SPEC (example: openclaw@2026.3.28)
  --artifacts-dir    Directory where logs and workflow artifacts are written
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function lastJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const brace = trimmed.lastIndexOf("{");
  if (brace < 0) return null;
  const candidate = trimmed.slice(brace);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
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

async function isPortAvailable(portNumber) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(portNumber, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailablePort(preferredPort, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `could not find an available port starting at ${preferredPort} within ${maxAttempts} attempts`,
  );
}

async function waitForLocalServer(portNumber, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server did not respond";

  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(
        `local server exited before becoming ready (code ${child.exitCode})`,
      );
    }
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
  const lines = [];
  const write = (streamName, chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      lines.push(`[${streamName}] ${line}`);
      if (!jsonOnly) {
        process.stderr.write(`[${prefix}:${streamName}] ${line}\n`);
      }
    }
  };
  child.stdout?.on("data", (chunk) => write("out", chunk));
  child.stderr?.on("data", (chunk) => write("err", chunk));
  return lines;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeTextFile(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function listJsonFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    const parsed = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => ({
          name,
          value: await readJsonIfExists(path.join(dirPath, name)),
        })),
    );
    return parsed
      .filter((entry) => entry.value && typeof entry.value === "object")
      .map((entry) => entry.value);
  } catch {
    return [];
  }
}

async function readWorkflowData(workflowDataDir) {
  const [runs, steps, events] = await Promise.all([
    listJsonFiles(path.join(workflowDataDir, "runs")),
    listJsonFiles(path.join(workflowDataDir, "steps")),
    listJsonFiles(path.join(workflowDataDir, "events")),
  ]);

  const sortByCreatedAt = (a, b) =>
    Date.parse(String(b.createdAt ?? 0)) - Date.parse(String(a.createdAt ?? 0));

  runs.sort(sortByCreatedAt);
  steps.sort(sortByCreatedAt);
  events.sort(sortByCreatedAt);

  return { runs, steps, events };
}

function selectLatestDrainRun(runs, startedAtMs) {
  return runs.find((run) => {
    if (!String(run.workflowName ?? "").includes("drain-channel-workflow")) {
      return false;
    }
    const createdAtMs = Date.parse(String(run.createdAt ?? ""));
    return Number.isFinite(createdAtMs) && createdAtMs >= startedAtMs - 10_000;
  }) ?? null;
}

function filterByRunId(records, runId) {
  return records.filter((record) => record?.runId === runId);
}

function findLatestAcceptedLog(logBody) {
  const logs = Array.isArray(logBody?.logs) ? logBody.logs : [];
  return logs.find((entry) => entry?.message === "channels.telegram_webhook_accepted") ?? null;
}

function classifyRequestLogOutcome(logs) {
  const entries = Array.isArray(logs?.body?.logs) ? logs.body.logs : [];
  const forwardResult = entries.find((entry) => entry?.message === "channels.workflow_native_forward_result") ?? null;
  const wakeSummary = entries.find((entry) => entry?.message === "channels.telegram_wake_summary") ?? null;
  const exhausted = entries.find((entry) => entry?.message === "channels.retrying_forward_exhausted") ?? null;

  if (forwardResult?.data && typeof forwardResult.data === "object") {
    const ok = forwardResult.data.ok === true;
    const status = typeof forwardResult.data.status === "number" ? forwardResult.data.status : null;
    return {
      outcome: ok ? "success" : "failed",
      status,
      forwardResult,
      wakeSummary,
      exhausted,
      logs: entries,
    };
  }

  if (exhausted) {
    return {
      outcome: "failed",
      status:
        typeof exhausted.data?.status === "number"
          ? exhausted.data.status
          : 504,
      forwardResult: null,
      wakeSummary,
      exhausted,
      logs: entries,
    };
  }

  return null;
}

function extractInterestingNextLines(lines, requestId) {
  return lines.filter((line) =>
    line.includes("[DIAG]") ||
    line.includes("openclaw.setup.") ||
    line.includes("sandbox.restore.") ||
    line.includes("sandbox.create.") ||
    line.includes("channels.telegram_") ||
    line.includes("channels.workflow_") ||
    line.includes("channels.native_forward_") ||
    line.includes("channels.retrying_forward_") ||
    (requestId ? line.includes(requestId) : false),
  );
}

async function fetchLocalRouteJson(portNumber, adminSecret, routePath, timeoutMs = 10_000) {
  try {
    const response = await fetch(`http://127.0.0.1:${portNumber}${routePath}`, {
      headers: {
        authorization: `Bearer ${adminSecret}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function persistLocalHarnessArtifacts({
  artifactsRoot,
  nextLogPath,
  vgrokLogPath,
  wakeStdoutPath,
  wakeStderrPath,
  summaryPath,
  nextLines,
  vgrokLines,
  summary,
  wakeResult,
}) {
  await ensureDir(artifactsRoot);
  await Promise.all([
    writeTextFile(nextLogPath, nextLines.length > 0 ? `${nextLines.join("\n")}\n` : ""),
    writeTextFile(vgrokLogPath, vgrokLines.length > 0 ? `${vgrokLines.join("\n")}\n` : ""),
    writeTextFile(wakeStdoutPath, `${JSON.stringify(wakeResult ?? null, null, 2)}\n`),
    writeTextFile(wakeStderrPath, summary.wakeError ? `${summary.wakeError}\n` : ""),
    writeTextFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
}

function buildRemoteUrl(baseUrl, routePath) {
  return new URL(routePath, baseUrl).href;
}

function buildRemoteHeaders(baseUrl, adminSecret, mutation = false) {
  const headers = {};
  if (adminSecret) {
    headers.authorization = `Bearer ${adminSecret}`;
  }
  if (mutation) {
    headers["content-type"] = "application/json";
    headers.origin = new URL(baseUrl).origin;
    headers["x-requested-with"] = "XMLHttpRequest";
  }
  return headers;
}

async function fetchRemoteJson(baseUrl, adminSecret, routePath, options = {}) {
  const response = await fetch(buildRemoteUrl(baseUrl, routePath), {
    method: options.method ?? "GET",
    headers: options.headers ?? buildRemoteHeaders(baseUrl, adminSecret, options.mutation ?? false),
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
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

async function ensureRunningRemote(baseUrl, adminSecret) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/admin/ensure?wait=1&timeoutMs=240000", {
    method: "POST",
    mutation: true,
    body: "{}",
    timeoutMs: 250_000,
  });
}

async function readChannelSummaryRemote(baseUrl, adminSecret) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/channels/summary");
}

async function configureSmokeChannelsRemote(baseUrl, adminSecret) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/admin/channel-secrets", {
    method: "PUT",
    mutation: true,
    body: "{}",
  });
}

async function cleanupSmokeChannelsRemote(baseUrl, adminSecret) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/admin/channel-secrets", {
    method: "DELETE",
    mutation: true,
    body: "{}",
  });
}

async function stopSandboxRemote(baseUrl, adminSecret) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/admin/stop", {
    method: "POST",
    mutation: true,
    body: "{}",
  });
}

async function sendSyntheticTelegramRemote(baseUrl, adminSecret, payloadBody) {
  return await fetchRemoteJson(baseUrl, adminSecret, "/api/admin/channel-secrets", {
    method: "POST",
    mutation: true,
    body: JSON.stringify({ channel: "telegram", body: payloadBody }),
  });
}

function buildTelegramPayload() {
  const updateId = Math.floor(Math.random() * 1_000_000_000);
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text: `/ask smoke token ${Date.now().toString(36)}`,
      chat: { id: 999_999_999, type: "private" },
      from: { id: 999_999_998, is_bot: false, first_name: "SmokeTest" },
      date: Math.floor(Date.now() / 1000),
    },
  };
}

async function waitForStoppedLocal(portNumber, adminSecret, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readLocalStatus(portNumber, adminSecret);
    if (status.ok && status.body?.status === "stopped") {
      return status.body;
    }
    await sleep(1_000);
  }
  throw new Error("sandbox did not reach stopped status");
}

async function waitForRunningLocal(portNumber, adminSecret, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = await readLocalStatus(portNumber, adminSecret);
    if (status.ok && status.body?.status === "running") {
      return status.body;
    }
    lastStatus = status.body?.status ?? status.status ?? "unknown";
    await sleep(1_000);
  }
  throw new Error(`sandbox did not reach running status (last status: ${String(lastStatus)})`);
}

async function stopSandboxRemoteWithRetry(baseUrl, adminSecret, localPort, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  let attempt = 0;
  let delayMs = 500;

  while (Date.now() < deadline) {
    attempt += 1;
    const localStatus = await readLocalStatus(localPort, adminSecret).catch(() => null);
    if (localStatus?.ok && localStatus.body?.status !== "running") {
      await sleep(750);
      continue;
    }

    const result = await stopSandboxRemote(baseUrl, adminSecret).catch((error) => ({
      ok: false,
      status: null,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    }));
    lastResult = result;

    if (result.ok) {
      return result;
    }

    const body = result.body;
    const transientLifecycleContention =
      result.status === 500 &&
      (body?.name === "LifecycleLockUnavailableError" ||
        body?.message === "Sandbox lifecycle lock unavailable." ||
        body?.error === "INTERNAL_ERROR");

    if (!transientLifecycleContention || Date.now() + delayMs >= deadline) {
      return result;
    }

    await sleep(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }

  return (
    lastResult ?? {
      ok: false,
      status: null,
      body: { error: "stop retry deadline exceeded" },
    }
  );
}

async function waitForAcceptedLogLocal(portNumber, adminSecret, sinceMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const logs = await fetchLocalRouteJson(
      portNumber,
      adminSecret,
      "/api/admin/logs?channel=telegram",
    );
    const entries = Array.isArray(logs.body?.logs) ? logs.body.logs : [];
    const accepted = entries.find((entry) =>
      entry?.message === "channels.telegram_webhook_accepted" &&
      typeof entry.timestamp === "number" &&
      entry.timestamp >= sinceMs
    ) ?? null;
    if (accepted) {
      return { accepted, logs };
    }
    latest = logs;
    await sleep(1_000);
  }
  return { accepted: null, logs: latest };
}

async function waitForWorkflowOutcome(workflowDataDir, startedAtMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestSnapshot = null;

  while (Date.now() < deadline) {
    const snapshot = await readWorkflowData(workflowDataDir);
    latestSnapshot = snapshot;
    const run = selectLatestDrainRun(snapshot.runs, startedAtMs);
    if (run) {
      const steps = filterByRunId(snapshot.steps, run.runId);
      const events = filterByRunId(snapshot.events, run.runId);
      const latestStep = steps[0] ?? null;
      const retryEvent = events.find((event) =>
        event?.eventType === "step_retrying" &&
        String(event?.eventData?.stack ?? "").includes("native_forward_failed status=504"),
      ) ?? null;
      const completedEvent = events.find((event) =>
        event?.eventType === "run_completed" || event?.eventType === "step_completed",
      ) ?? null;
      const failedEvent = events.find((event) =>
        event?.eventType === "run_failed" || event?.eventType === "step_failed",
      ) ?? null;

      if (retryEvent) {
        return {
          outcome: "retrying-failure",
          run,
          latestStep,
          steps,
          events,
          retryEvent,
        };
      }
      if (failedEvent) {
        return {
          outcome: "failed",
          run,
          latestStep,
          steps,
          events,
          failedEvent,
        };
      }
      if (completedEvent || latestStep?.status === "completed") {
        return {
          outcome: "success",
          run,
          latestStep,
          steps,
          events,
          completedEvent: completedEvent ?? null,
        };
      }
    }

    await sleep(1_000);
  }

  return {
    outcome: "timeout",
    run: selectLatestDrainRun(latestSnapshot?.runs ?? [], startedAtMs),
    steps: latestSnapshot?.steps ?? [],
    events: latestSnapshot?.events ?? [],
    latestStep: null,
  };
}

async function waitForRequestLogOutcome(portNumber, adminSecret, requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLogs = null;

  while (Date.now() < deadline) {
    const logs = await fetchLocalRouteJson(
      portNumber,
      adminSecret,
      `/api/admin/logs?channel=telegram&requestId=${encodeURIComponent(requestId)}`,
    );
    lastLogs = logs;
    const classified = classifyRequestLogOutcome(logs);
    if (classified) {
      return classified;
    }
    await sleep(1_000);
  }

  return {
    outcome: "timeout",
    status: null,
    forwardResult: null,
    wakeSummary: null,
    exhausted: null,
    logs: Array.isArray(lastLogs?.body?.logs) ? lastLogs.body.logs : [],
  };
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

  const selectedPort = await resolveAvailablePort(port);
  if (selectedPort !== port) {
    log(`port ${port} is busy; using ${selectedPort} instead`);
  }

  const localInstanceId =
    values["instance-id"]?.trim() ||
    `local-vgrok-${Date.now().toString(36)}`;
  const openclawPackageSpec = values["openclaw-package-spec"]?.trim() || null;
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactsRoot =
    values["artifacts-dir"]?.trim()
      ? path.resolve(values["artifacts-dir"])
      : path.join(repoRoot, ".artifacts", "telegram-wake-local", `${runStamp}-${localInstanceId}`);
  const workflowDataDir = path.join(artifactsRoot, "workflow-data");
  const nextLogPath = path.join(artifactsRoot, "next.log");
  const vgrokLogPath = path.join(artifactsRoot, "vgrok.log");
  const wakeStdoutPath = path.join(artifactsRoot, "wake.stdout.log");
  const wakeStderrPath = path.join(artifactsRoot, "wake.stderr.log");
  const summaryPath = path.join(artifactsRoot, "summary.json");

  await fs.rm(artifactsRoot, { recursive: true, force: true });
  await ensureDir(artifactsRoot);

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
  sanitizedEnv.set("PORT", String(selectedPort));
  sanitizedEnv.set("WORKFLOW_LOCAL_BASE_URL", `http://127.0.0.1:${selectedPort}`);
  sanitizedEnv.set("WORKFLOW_LOCAL_DATA_DIR", workflowDataDir);
  if (openclawPackageSpec) {
    sanitizedEnv.set("OPENCLAW_PACKAGE_SPEC", openclawPackageSpec);
  }

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
  let nextLines = [];
  let vgrokLines = [];
  let requestId = null;
  let configuredByUs = false;
  let currentPhase = "starting";
  let failureMessage = null;
  let summary = null;

  try {
    if (originalEnvLocal !== null) {
      await fs.writeFile(backupEnvLocalPath, originalEnvLocal, "utf8");
    }
    await fs.writeFile(envLocalPath, serializeEnvFile(sanitizedEnv), "utf8");
    currentPhase = "env-sanitized";
    log(`sanitized .env.local written with OPENCLAW_INSTANCE_ID=${localInstanceId}`);

    devChild = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_SECRET: adminSecret,
        OPENCLAW_INSTANCE_ID: localInstanceId,
        PORT: String(selectedPort),
        WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${selectedPort}`,
        WORKFLOW_LOCAL_DATA_DIR: workflowDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    nextLines = attachPrefixedLogs(devChild, "next");

    currentPhase = "waiting-for-local-server";
    await waitForLocalServer(selectedPort, 120_000, devChild);
    log(`local server is ready on port ${selectedPort}`);
    currentPhase = "waiting-for-initial-setup";
    await waitForServerNotInSetup(selectedPort, adminSecret, 20 * 60_000);
    log("local server is past initial setup");

    vgrokChild = spawn("npx", ["@styfle/vgrok", String(selectedPort)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ADMIN_SECRET: adminSecret,
        OPENCLAW_INSTANCE_ID: localInstanceId,
        PORT: String(selectedPort),
        WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${selectedPort}`,
        WORKFLOW_LOCAL_DATA_DIR: workflowDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    vgrokLines = attachPrefixedLogs(vgrokChild, "vgrok");

    currentPhase = "waiting-for-vgrok";
    tunnelUrl = await waitForVgrokUrl(vgrokChild, 90_000);
    log(`vgrok tunnel ready at ${tunnelUrl}`);
    currentPhase = "ensuring-remote";
    const ensureResult = await ensureRunningRemote(tunnelUrl, adminSecret);
    if (!ensureResult.ok) {
      throw new Error(`ensure failed: HTTP ${ensureResult.status} ${JSON.stringify(ensureResult.body)}`);
    }
    currentPhase = "waiting-for-running";
    await waitForRunningLocal(selectedPort, adminSecret, 30_000);

    const initialSummary = await readChannelSummaryRemote(tunnelUrl, adminSecret);
    if (!initialSummary.ok) {
      throw new Error(`channel summary failed: HTTP ${initialSummary.status} ${JSON.stringify(initialSummary.body)}`);
    }
    if (!initialSummary.body?.telegram?.configured) {
      currentPhase = "configuring-smoke-channels";
      const configureResult = await configureSmokeChannelsRemote(tunnelUrl, adminSecret);
      if (!configureResult.ok) {
        throw new Error(`configure smoke channels failed: HTTP ${configureResult.status} ${JSON.stringify(configureResult.body)}`);
      }
      configuredByUs = true;
    }

    currentPhase = "stopping-sandbox";
    const stopResult = await stopSandboxRemoteWithRetry(
      tunnelUrl,
      adminSecret,
      selectedPort,
      30_000,
    );
    if (!stopResult.ok) {
      throw new Error(`stop failed: HTTP ${stopResult.status} ${JSON.stringify(stopResult.body)}`);
    }
    currentPhase = "waiting-for-stopped";
    await waitForStoppedLocal(selectedPort, adminSecret, 60_000);

    const triggerPayload = buildTelegramPayload();
    const workflowStartedAt = Date.now();
    currentPhase = "sending-telegram";
    const webhookResult = await sendSyntheticTelegramRemote(
      tunnelUrl,
      adminSecret,
      JSON.stringify(triggerPayload),
    );
    if (!webhookResult.ok || !webhookResult.body?.sent) {
      throw new Error(`telegram dispatch failed: HTTP ${webhookResult.status} ${JSON.stringify(webhookResult.body)}`);
    }

    currentPhase = "waiting-for-accepted-log";
    const acceptedInfo = await waitForAcceptedLogLocal(
      selectedPort,
      adminSecret,
      workflowStartedAt,
      30_000,
    );
    const acceptedLog = acceptedInfo.accepted;
    requestId = typeof acceptedLog?.data?.requestId === "string"
      ? acceptedLog.data.requestId
      : null;

    currentPhase = "waiting-for-workflow-outcome";
    const workflowOutcomePromise = waitForWorkflowOutcome(
      workflowDataDir,
      workflowStartedAt,
      timeoutSec * 1000,
    );

    currentPhase = "waiting-for-request-outcome";
    const requestOutcome = requestId
      ? await waitForRequestLogOutcome(
          selectedPort,
          adminSecret,
          requestId,
          timeoutSec * 1000,
        )
      : null;

    const finalWorkflow = await readWorkflowData(workflowDataDir);
    const workflowOutcome = requestOutcome && requestOutcome.outcome !== "timeout"
      ? await Promise.race([
          workflowOutcomePromise,
          sleep(3_000).then(() => null),
        ])
      : await workflowOutcomePromise;
    const resolvedWorkflowOutcome = workflowOutcome ?? {
      outcome: "pending",
      run: selectLatestDrainRun(finalWorkflow.runs, workflowStartedAt),
      steps: finalWorkflow.steps,
      events: finalWorkflow.events,
      latestStep: null,
    };
    const selectedRun =
      resolvedWorkflowOutcome.run ??
      selectLatestDrainRun(finalWorkflow.runs, workflowStartedAt);
    const workflowSteps = selectedRun
      ? filterByRunId(finalWorkflow.steps, selectedRun.runId)
      : [];
    const workflowEvents = selectedRun
      ? filterByRunId(finalWorkflow.events, selectedRun.runId)
      : [];

    let wakeError = null;
    if (!(requestOutcome?.outcome === "success" || resolvedWorkflowOutcome.outcome === "success")) {
      if (typeof requestOutcome?.forwardResult?.data?.status === "number") {
        wakeError = `native_forward_failed status=${requestOutcome.forwardResult.data.status}`;
      } else if (typeof requestOutcome?.status === "number") {
        wakeError = `native_forward_failed status=${requestOutcome.status}`;
      } else if (requestOutcome?.outcome === "failed") {
        wakeError = "native_forward_failed status=504";
      } else if (requestOutcome?.outcome === "timeout") {
        wakeError = "request outcome timeout";
      } else {
        wakeError =
          resolvedWorkflowOutcome.retryEvent?.eventData?.stack ??
          resolvedWorkflowOutcome.failedEvent?.eventData?.stack ??
          workflowSteps[0]?.error?.message ??
          `workflow outcome: ${resolvedWorkflowOutcome.outcome}`;
      }
    }

    wakeResult = {
      schemaVersion: 1,
      type: "telegram-wake-test-local-driver",
      passed:
        requestOutcome?.outcome === "success" ||
        resolvedWorkflowOutcome.outcome === "success",
      generatedAt: new Date().toISOString(),
      baseUrl: tunnelUrl,
      webhook: webhookResult.body,
      acceptedLog,
      workflowOutcome: resolvedWorkflowOutcome,
      requestOutcome,
      error: wakeError,
    };

    const localStatus = await fetchLocalRouteJson(selectedPort, adminSecret, "/api/status");
    const localDiag = await fetchLocalRouteJson(
      selectedPort,
      adminSecret,
      "/api/admin/channel-forward-diag",
    );
    const telegramLogs = await fetchLocalRouteJson(
      selectedPort,
      adminSecret,
      "/api/admin/logs?channel=telegram",
    );
    const requestLogs = requestId
      ? await fetchLocalRouteJson(
          selectedPort,
          adminSecret,
          `/api/admin/logs?channel=telegram&requestId=${encodeURIComponent(requestId)}`,
        )
      : null;

    const nextInterestingLines = extractInterestingNextLines(nextLines, requestId);

    summary = {
      schemaVersion: 1,
      type: "telegram-wake-local-test",
      passed: wakeResult?.passed === true,
      generatedAt: new Date().toISOString(),
      requestedPort: port,
      port: selectedPort,
      tunnelUrl,
      openclawInstanceId: localInstanceId,
      openclawPackageSpec,
      elapsedMs: Date.now() - startedAt,
      artifactsRoot,
      workflowDataDir,
      wakeError: wakeResult?.error ?? null,
      requestId,
      wake: wakeResult ?? null,
      acceptedLog: wakeResult?.acceptedLog ?? acceptedLog ?? null,
      localStatus,
      localDiag,
      telegramLogs,
      requestLogs,
      workflow: {
        run: selectedRun,
        steps: workflowSteps,
        events: workflowEvents,
      },
      nextInterestingLines,
    };

    currentPhase = "completed";
    await persistLocalHarnessArtifacts({
      artifactsRoot,
      nextLogPath,
      vgrokLogPath,
      wakeStdoutPath,
      wakeStderrPath,
      summaryPath,
      nextLines,
      vgrokLines,
      summary,
      wakeResult,
    });

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stderr.write(`\n[telegram-wake-local] tunnel: ${tunnelUrl}\n`);
      process.stderr.write(`[telegram-wake-local] instance: ${localInstanceId}\n`);
      process.stderr.write(`[telegram-wake-local] elapsed: ${summary.elapsedMs}ms\n`);
      process.stderr.write(`[telegram-wake-local] artifacts: ${artifactsRoot}\n`);
    }

    return summary.passed ? 0 : 1;
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    currentPhase = `${currentPhase}:failed`;
    throw error;
  } finally {
    if (configuredByUs && tunnelUrl) {
      await cleanupSmokeChannelsRemote(tunnelUrl, adminSecret).catch(() => {});
    }
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

    if (!summary) {
      const [localStatus, localDiag, telegramLogs, workflowSnapshot] = await Promise.all([
        fetchLocalRouteJson(selectedPort, adminSecret, "/api/status").catch(() => ({
          ok: false,
          status: null,
          body: null,
        })),
        fetchLocalRouteJson(
          selectedPort,
          adminSecret,
          "/api/admin/channel-forward-diag",
        ).catch(() => ({
          ok: false,
          status: null,
          body: null,
        })),
        fetchLocalRouteJson(
          selectedPort,
          adminSecret,
          "/api/admin/logs?channel=telegram",
        ).catch(() => ({
          ok: false,
          status: null,
          body: null,
        })),
        readWorkflowData(workflowDataDir).catch(() => ({
          runs: [],
          steps: [],
          events: [],
        })),
      ]);
      const acceptedLog = findLatestAcceptedLog(telegramLogs.body);
      const failureRequestId =
        requestId ??
        (typeof acceptedLog?.data?.requestId === "string"
          ? acceptedLog.data.requestId
          : null);
      const selectedRun = selectLatestDrainRun(workflowSnapshot.runs, startedAt);
      const workflowSteps = selectedRun
        ? filterByRunId(workflowSnapshot.steps, selectedRun.runId)
        : [];
      const workflowEvents = selectedRun
        ? filterByRunId(workflowSnapshot.events, selectedRun.runId)
        : [];

      summary = {
        schemaVersion: 1,
        type: "telegram-wake-local-test",
        passed: false,
        generatedAt: new Date().toISOString(),
        requestedPort: port,
        port: selectedPort,
        tunnelUrl,
        openclawInstanceId: localInstanceId,
        openclawPackageSpec,
        elapsedMs: Date.now() - startedAt,
        artifactsRoot,
        workflowDataDir,
        phase: currentPhase,
        wakeError: failureMessage,
        requestId: failureRequestId,
        wake: wakeResult ?? null,
        acceptedLog,
        localStatus,
        localDiag,
        telegramLogs,
        requestLogs: failureRequestId
          ? await fetchLocalRouteJson(
              selectedPort,
              adminSecret,
              `/api/admin/logs?channel=telegram&requestId=${encodeURIComponent(failureRequestId)}`,
            ).catch(() => null)
          : null,
        workflow: {
          run: selectedRun,
          steps: workflowSteps,
          events: workflowEvents,
        },
        nextInterestingLines: extractInterestingNextLines(nextLines, failureRequestId),
      };
    }

    await persistLocalHarnessArtifacts({
      artifactsRoot,
      nextLogPath,
      vgrokLogPath,
      wakeStdoutPath,
      wakeStderrPath,
      summaryPath,
      nextLines,
      vgrokLines,
      summary,
      wakeResult,
    }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fatal: ${message}\n`);
    process.exit(1);
  });
