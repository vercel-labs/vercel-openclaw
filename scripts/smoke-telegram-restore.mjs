#!/usr/bin/env node

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "admin-secret": { type: "string" },
    "protection-bypass": { type: "string" },
    team: { type: "string" },
    "project-id": { type: "string" },
    "bot-token": { type: "string" },
    "chat-id": { type: "string" },
    trigger: { type: "string", default: "real-reply" },
    timeout: { type: "string", default: "600" },
    "request-timeout": { type: "string", default: "30" },
    "json-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`smoke-telegram-restore - full Telegram restore smoke harness

USAGE
  node scripts/smoke-telegram-restore.mjs [options]

OPTIONS
  --base-url           App base URL. Defaults to OPENCLAW_BASE_URL.
  --admin-secret       Admin bearer token. Defaults to ADMIN_SECRET.
  --protection-bypass  Vercel protection bypass secret. Defaults to VERCEL_AUTOMATION_BYPASS_SECRET.
  --team               Vercel team slug. Defaults to OPENCLAW_SCOPE.
  --project-id         Vercel project id. Defaults to OPENCLAW_PROJECT_ID.
  --bot-token          Telegram bot token. Defaults to TELEGRAM_BOT_ID.
  --chat-id            Telegram chat id. If omitted, the script learns the latest chat id from admin logs.
  --trigger            real-reply | synthetic (default: real-reply)
  --timeout            Overall timeout in seconds (default: 600)
  --request-timeout    Per-request timeout in seconds (default: 30)
  --json-only          Emit only the final JSON report.
  --help               Show this help.

FLOW
  1. Resolve the live aliased deployment
  2. POST /api/admin/reset and wait for status=uninitialized
  3. POST /api/admin/ensure?wait=1 to create a fresh sandbox using the real install path
  4. POST /api/admin/stop and wait for status=stopped
  5. Trigger Telegram:
     - real-reply: send a real Telegram prompt to your chat and wait for your reply
     - synthetic: dispatch a signed synthetic Telegram webhook
  6. Poll admin logs, workflow runs/steps/events, /api/status, and /api/admin/channel-forward-diag
  7. Print a single JSON report with the full trace

NOTES
  Telegram does not let a bot fabricate a real inbound user update to itself.
  The real-reply mode sends a real Telegram message to your chat and waits for
  your reply to trigger the inbound webhook path.
`);
  process.exit(0);
}

const baseUrl = values["base-url"]?.trim() || process.env.OPENCLAW_BASE_URL?.trim() || "";
const adminSecret =
  values["admin-secret"]?.trim() || process.env.ADMIN_SECRET?.trim() || "";
const protectionBypass =
  values["protection-bypass"]?.trim()
  || process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
  || "";
const team = values.team?.trim() || process.env.OPENCLAW_SCOPE?.trim() || "";
const projectId =
  values["project-id"]?.trim() || process.env.OPENCLAW_PROJECT_ID?.trim() || "";
const botToken =
  values["bot-token"]?.trim() || process.env.TELEGRAM_BOT_ID?.trim() || "";
const trigger = values.trigger?.trim() || "real-reply";
const explicitChatId = values["chat-id"]?.trim() || "";
const timeoutMs = Number.parseInt(values.timeout, 10) * 1000;
const requestTimeoutMs = Number.parseInt(values["request-timeout"], 10) * 1000;
const jsonOnly = values["json-only"];

if (!baseUrl) {
  process.stderr.write("error: --base-url is required (or set OPENCLAW_BASE_URL)\n");
  process.exit(2);
}
if (!adminSecret) {
  process.stderr.write("error: --admin-secret is required (or set ADMIN_SECRET)\n");
  process.exit(2);
}
if (!protectionBypass) {
  process.stderr.write(
    "error: --protection-bypass is required (or set VERCEL_AUTOMATION_BYPASS_SECRET)\n",
  );
  process.exit(2);
}
if (!team) {
  process.stderr.write("error: --team is required (or set OPENCLAW_SCOPE)\n");
  process.exit(2);
}
if (!projectId) {
  process.stderr.write("error: --project-id is required (or set OPENCLAW_PROJECT_ID)\n");
  process.exit(2);
}
if (trigger !== "real-reply" && trigger !== "synthetic") {
  process.stderr.write("error: --trigger must be one of: real-reply, synthetic\n");
  process.exit(2);
}
if (trigger === "real-reply" && !botToken) {
  process.stderr.write("error: --bot-token is required for real-reply mode\n");
  process.exit(2);
}

function log(message) {
  if (!jsonOnly) {
    process.stderr.write(`[smoke-telegram-restore] ${message}\n`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(pathname) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("x-vercel-protection-bypass", protectionBypass);
  return url.href;
}

function buildHeaders({ mutation = false } = {}) {
  const headers = {
    authorization: `Bearer ${adminSecret}`,
  };
  if (mutation) {
    headers["content-type"] = "application/json";
    headers.origin = new URL(baseUrl).origin;
    headers["x-requested-with"] = "XMLHttpRequest";
  }
  return headers;
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(buildUrl(pathname), {
    method: options.method ?? "GET",
    headers: options.headers ?? buildHeaders({ mutation: options.mutation ?? false }),
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body, text };
}

async function runCommand(cmd, args) {
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function resolveLiveDeployment() {
  const result = await runCommand("vercel", ["inspect", baseUrl, "--scope", team]);
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/^\s*id\s+([A-Za-z0-9_]+)/m);
  return {
    code: result.code,
    deploymentId: match?.[1] ?? null,
    raw: combined.trim(),
  };
}

async function inspectWorkflowRuns() {
  const result = await runCommand("npx", [
    "workflow",
    "inspect",
    "runs",
    "-b",
    "vercel",
    "--team",
    team,
    "--project",
    projectId,
    "--limit",
    "20",
    "-j",
  ]);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout, data: [] };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout).data ?? [] };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: [],
      raw: result.stdout,
    };
  }
}

async function inspectWorkflowSteps(runId) {
  const result = await runCommand("npx", [
    "workflow",
    "inspect",
    "steps",
    "-b",
    "vercel",
    "--team",
    team,
    "--project",
    projectId,
    "--runId",
    runId,
    "-j",
  ]);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout, data: [] };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: [],
      raw: result.stdout,
    };
  }
}

async function inspectWorkflowEvents(runId) {
  const result = await runCommand("npx", [
    "workflow",
    "inspect",
    "events",
    "-b",
    "vercel",
    "--team",
    team,
    "--project",
    projectId,
    "--runId",
    runId,
    "-j",
  ]);
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout, data: [] };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      data: [],
      raw: result.stdout,
    };
  }
}

async function readStatus() {
  const result = await fetchJson("/api/status");
  if (!result.ok || !result.body || typeof result.body !== "object") {
    throw new Error(`status failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function readTelegramLogs(filters = "") {
  const suffix = filters ? `&${filters}` : "";
  const result = await fetchJson(`/api/admin/logs?channel=telegram${suffix}`);
  if (!result.ok || !result.body || typeof result.body !== "object") {
    throw new Error(`admin logs failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function readDiag() {
  const result = await fetchJson("/api/admin/channel-forward-diag");
  if (!result.ok || !result.body || typeof result.body !== "object") {
    return null;
  }
  return result.body;
}

async function waitForStatus(label, predicate, timeoutMsLocal) {
  const startedAt = Date.now();
  const timeline = [];
  let delay = 1_000;
  let lastStatus = null;

  while (Date.now() - startedAt < timeoutMsLocal) {
    let statusBody = null;
    try {
      statusBody = await readStatus();
      lastStatus = statusBody.status ?? null;
      timeline.push({
        atMs: Date.now(),
        elapsedMs: Date.now() - startedAt,
        status: statusBody.status ?? null,
        sandboxId: statusBody.sandboxId ?? null,
        snapshotId: statusBody.snapshotId ?? null,
        openclawVersion: statusBody.openclawVersion ?? null,
        setupPhase: statusBody.setupProgress?.phase ?? null,
        setupPreview: statusBody.setupProgress?.preview ?? null,
      });
      if (predicate(statusBody)) {
        log(`${label}: reached status=${statusBody.status}`);
        return {
          ok: true,
          waitedMs: Date.now() - startedAt,
          body: statusBody,
          timeline,
        };
      }
      log(
        `${label}: status=${statusBody.status} setup=${statusBody.setupProgress?.phase ?? "n/a"}`,
      );
    } catch (error) {
      timeline.push({
        atMs: Date.now(),
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.35), 5_000);
  }

  return {
    ok: false,
    waitedMs: Date.now() - startedAt,
    lastStatus,
    timeline,
  };
}

async function resetSandbox() {
  log("phase: reset sandbox");
  const response = await fetchJson("/api/admin/reset", {
    method: "POST",
    mutation: true,
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`reset failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function createFreshSandbox() {
  log("phase: create fresh sandbox via ensure(wait=1)");
  const response = await fetchJson("/api/admin/ensure?wait=1&timeoutMs=240000", {
    method: "POST",
    mutation: true,
    body: "{}",
    timeoutMs: 250_000,
  });
  if (!response.ok) {
    throw new Error(`ensure failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function stopSandbox() {
  log("phase: stop sandbox");
  const deadline = Date.now() + 20_000;
  let delay = 500;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const response = await fetchJson("/api/admin/stop", {
      method: "POST",
      mutation: true,
      body: "{}",
    });
    if (response.ok) {
      return { attempts: attempt, body: response.body };
    }

    const retryable = response.status === 500 && response.body?.error === "INTERNAL_ERROR";
    if (!retryable || Date.now() + delay >= deadline) {
      throw new Error(`stop failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 2_000);
  }

  throw new Error("stop failed: lifecycle lock contention did not clear in time");
}

function latestTelegramAcceptedLog(logBody, sinceMs, chatId) {
  const logs = Array.isArray(logBody?.logs) ? logBody.logs : [];
  return logs.find((entry) => {
    if (entry?.message !== "channels.telegram_webhook_accepted") {
      return false;
    }
    if (typeof entry.timestamp !== "number" || entry.timestamp < sinceMs) {
      return false;
    }
    if (chatId && String(entry.data?.chatId ?? "") !== String(chatId)) {
      return false;
    }
    return true;
  }) ?? null;
}

async function discoverChatId() {
  if (explicitChatId) {
    return explicitChatId;
  }
  const logBody = await readTelegramLogs();
  const logs = Array.isArray(logBody.logs) ? logBody.logs : [];
  for (const entry of logs) {
    const chatId = entry?.data?.chatId;
    if (entry?.message === "channels.telegram_webhook_accepted" && chatId) {
      return String(chatId);
    }
  }
  throw new Error("Unable to discover Telegram chat id from recent admin logs");
}

function buildSyntheticPayload(token) {
  const updateId = Math.floor(Math.random() * 1_000_000_000);
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      text: `/ask smoke token ${token}`,
      chat: { id: 999_999_999, type: "private" },
      from: { id: 999_999_998, is_bot: false, first_name: "SmokeTest" },
      date: Math.floor(Date.now() / 1000),
    },
  });
}

async function dispatchSyntheticTrigger(token) {
  const response = await fetchJson("/api/admin/channel-secrets", {
    method: "POST",
    mutation: true,
    body: JSON.stringify({
      channel: "telegram",
      body: buildSyntheticPayload(token),
    }),
  });
  if (!response.ok || !response.body?.sent) {
    throw new Error(
      `synthetic telegram dispatch failed: HTTP ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function sendRealTelegramPrompt(chatId, token) {
  const message =
    `OpenClaw smoke ${token}\n`
    + "Reply to this message with any text to trigger the restore trace.";
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok || !body?.ok) {
    throw new Error(`telegram sendMessage failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function waitForInboundAccepted(chatId, sinceMs, timeoutMsLocal) {
  log("phase: waiting for inbound Telegram webhook acceptance");
  const startedAt = Date.now();
  let delay = 2_000;
  let lastLogBody = null;

  while (Date.now() - startedAt < timeoutMsLocal) {
    const logBody = await readTelegramLogs();
    lastLogBody = logBody;
    const accepted = latestTelegramAcceptedLog(logBody, sinceMs, chatId);
    if (accepted) {
      return {
        ok: true,
        accepted,
        waitedMs: Date.now() - startedAt,
      };
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.25), 5_000);
  }

  return {
    ok: false,
    waitedMs: Date.now() - startedAt,
    logs: lastLogBody,
  };
}

async function waitForMatchingDiag(requestId, timeoutMsLocal) {
  log("phase: waiting for matching channel-forward diag");
  const startedAt = Date.now();
  let delay = 2_000;
  let lastDiag = null;

  while (Date.now() - startedAt < timeoutMsLocal) {
    const diag = await readDiag();
    if (diag) {
      lastDiag = diag;
      if (diag.requestId === requestId && (diag.completedAt || diag.outcome)) {
        return { ok: true, diag, waitedMs: Date.now() - startedAt };
      }
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 5_000);
  }

  return {
    ok: false,
    waitedMs: Date.now() - startedAt,
    diag: lastDiag,
  };
}

function selectWorkflowRun(runs, acceptedTimestamp) {
  const candidates = runs.filter((run) => {
    if (!String(run.workflowName ?? "").includes("drain-channel-workflow")) {
      return false;
    }
    const createdAtMs = Date.parse(run.createdAt);
    return Number.isFinite(createdAtMs) && createdAtMs >= acceptedTimestamp - 15_000;
  });
  if (candidates.length === 0) {
    return null;
  }
  return candidates
    .slice()
    .sort((a, b) => Math.abs(Date.parse(a.createdAt) - acceptedTimestamp) - Math.abs(Date.parse(b.createdAt) - acceptedTimestamp))[0];
}

function buildRestoreHarnessGuide(report) {
  const acceptedRequestId = report.acceptedLog?.data?.requestId ?? null;
  const requestEntries = Array.isArray(report.requestLogs?.logs) ? report.requestLogs.logs : [];
  const forwardResult =
    requestEntries.find((entry) => entry?.message === "channels.workflow_native_forward_result") ?? null;
  const wakeSummary =
    requestEntries.find((entry) => entry?.message === "channels.telegram_wake_summary") ?? null;
  const diagBody = report.diag?.diag ?? report.diag?.body ?? report.diag ?? null;

  return {
    measures: [
      "full restore path from reset to fresh sandbox to stopped sandbox wake",
      "real-reply or synthetic Telegram ingress against a live aliased deployment",
      "workflow run/step/event evidence matched to the accepted request",
      "final channel-forward diagnostic for the matched request when available",
    ],
    captures: {
      deploymentInspect: true,
      statusTimeline: true,
      acceptedWebhookLog: !!report.acceptedLog,
      requestScopedTelegramLogs: requestEntries.length > 0,
      workflowRunsStepsEvents: !!report.workflow?.run,
      channelForwardDiag: Boolean(diagBody),
      realTelegramPromptMetadata: Boolean(report.promptMessage),
    },
    keySignals: {
      requestId: acceptedRequestId,
      acceptedMessage: report.acceptedLog?.message ?? null,
      forwardStatus: forwardResult?.data?.status ?? null,
      forwardOk: forwardResult?.data?.ok ?? null,
      wakePhase: wakeSummary?.data?.phase ?? null,
      wakeOutcome: wakeSummary?.data?.outcome ?? null,
      workflowRunId: report.workflow?.run?.runId ?? null,
      diagOutcome: diagBody?.outcome ?? null,
      diagForwardStatus: diagBody?.forwardStatus ?? null,
    },
    recommendedUse:
      "Use after a version has already been narrowed down to isolate whether the failure is ingress, readiness, workflow, or native-forward behavior on a live deployment.",
  };
}

async function waitForWorkflowRun(acceptedTimestamp, timeoutMsLocal) {
  log("phase: waiting for workflow run");
  const startedAt = Date.now();
  let delay = 2_000;
  let lastRuns = [];

  while (Date.now() - startedAt < timeoutMsLocal) {
    const runsResult = await inspectWorkflowRuns();
    if (runsResult.ok) {
      lastRuns = runsResult.data;
      const run = selectWorkflowRun(runsResult.data, acceptedTimestamp);
      if (run) {
        return {
          ok: true,
          run,
          waitedMs: Date.now() - startedAt,
          runs: runsResult.data,
        };
      }
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.4), 5_000);
  }

  return {
    ok: false,
    waitedMs: Date.now() - startedAt,
    runs: lastRuns,
  };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    baseUrl,
    trigger,
    team,
    projectId,
    deployment: null,
    phases: {},
    finalStatus: null,
    acceptedLog: null,
    requestLogs: null,
    workflow: {
      run: null,
      steps: null,
      events: null,
    },
    diag: null,
    promptMessage: null,
  };

  const overallStartedAt = Date.now();

  report.deployment = await resolveLiveDeployment();

  report.phases.preResetStatus = await readStatus();

  await resetSandbox();
  report.phases.resetWait = await waitForStatus(
    "reset-wait",
    (body) => body.status === "uninitialized",
    180_000,
  );
  if (!report.phases.resetWait.ok) {
    throw new Error("reset did not reach uninitialized");
  }

  report.phases.createFresh = {
    startedAt: Date.now(),
    ensureResult: await createFreshSandbox(),
  };
  report.phases.postCreateStatus = await readStatus();

  report.phases.stop = await stopSandbox();
  report.phases.stopWait = await waitForStatus(
    "stop-wait",
    (body) => body.status === "stopped",
    120_000,
  );
  if (!report.phases.stopWait.ok) {
    throw new Error("sandbox did not stop cleanly");
  }

  const token = `smoke-${Date.now().toString(36)}`;
  let triggerSinceMs = Date.now();

  if (trigger === "real-reply") {
    const chatId = await discoverChatId();
    report.phases.chatId = chatId;
    report.promptMessage = await sendRealTelegramPrompt(chatId, token);
    triggerSinceMs = Date.now();
    log(`prompt sent to chat ${chatId}; waiting for your reply in Telegram`);
    report.phases.inboundWait = await waitForInboundAccepted(chatId, triggerSinceMs, timeoutMs);
  } else {
    report.phases.syntheticDispatch = await dispatchSyntheticTrigger(token);
    report.phases.inboundWait = await waitForInboundAccepted(null, triggerSinceMs, 60_000);
  }

  if (!report.phases.inboundWait.ok) {
    throw new Error("did not observe inbound Telegram webhook acceptance");
  }

  report.acceptedLog = report.phases.inboundWait.accepted;

  const requestId = report.acceptedLog.data?.requestId ?? null;
  if (requestId) {
    report.requestLogs = await readTelegramLogs(`requestId=${encodeURIComponent(requestId)}`);
  }

  report.workflow.lookup = await waitForWorkflowRun(report.acceptedLog.timestamp, 90_000);
  if (report.workflow.lookup.ok && report.workflow.lookup.run?.runId) {
    report.workflow.run = report.workflow.lookup.run;
    report.workflow.steps = await inspectWorkflowSteps(report.workflow.run.runId);
    report.workflow.events = await inspectWorkflowEvents(report.workflow.run.runId);
  }

  if (requestId) {
    report.diag = await waitForMatchingDiag(requestId, 120_000);
  } else {
    report.diag = { ok: false, error: "requestId missing on accepted log" };
  }

  report.finalStatus = await readStatus();
  report.completedAt = new Date().toISOString();
  report.totalDurationMs = Date.now() - overallStartedAt;
  report.harness = buildRestoreHarnessGuide(report);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    completedAt: new Date().toISOString(),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
