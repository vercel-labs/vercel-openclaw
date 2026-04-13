#!/usr/bin/env node

/**
 * Autonomous Telegram wake-from-sleep test.
 *
 * Stops the sandbox, sends a synthetic Telegram webhook via the
 * channel-secrets endpoint, polls until the sandbox wakes up and the
 * message is processed, then reads the channel-forward-diag for a
 * timing breakdown.
 *
 * If Telegram is not already configured, the script can auto-configure
 * smoke test channel credentials via PUT /api/admin/channel-secrets and
 * remove them afterward. This keeps local/public tunnel testing realistic
 * without requiring a real Telegram bot.
 *
 * Usage:
 *   node scripts/test-telegram-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret>
 *   node scripts/test-telegram-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --timeout 180
 *   node scripts/test-telegram-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --json-only
 *   node scripts/test-telegram-wake.mjs --base-url https://my-app.vercel.app --admin-secret <secret> --protection-bypass <secret>
 *
 * Environment:
 *   ADMIN_SECRET                    — admin bearer token (overridden by --admin-secret)
 *   SMOKE_AUTH_COOKIE               — auth cookie for sign-in-with-vercel mode (overridden by --auth-cookie)
 *   VERCEL_AUTOMATION_BYPASS_SECRET — deployment protection bypass (overridden by --protection-bypass)
 *
 * Exit codes:
 *   0 — wake-from-sleep succeeded, message was processed
 *   1 — wake-from-sleep failed (message lost, timeout, or error)
 *   2 — bad arguments
 */

import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "admin-secret": { type: "string" },
    "auth-cookie": { type: "string" },
    "protection-bypass": { type: "string" },
    timeout: { type: "string", default: "180" },
    "request-timeout": { type: "string", default: "30" },
    "json-only": { type: "boolean", default: false },
    "skip-cleanup": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`test-telegram-wake — autonomous Telegram wake-from-sleep test

USAGE
  node scripts/test-telegram-wake.mjs --base-url <url> --admin-secret <secret> [options]

OPTIONS
  --base-url           (required) Deployed app URL
  --admin-secret       Admin bearer token (or set ADMIN_SECRET env var)
  --auth-cookie        Auth cookie value (or set SMOKE_AUTH_COOKIE env var)
  --protection-bypass  Deployment protection bypass secret (or set VERCEL_AUTOMATION_BYPASS_SECRET)
  --timeout            Overall timeout in seconds for wake polling (default: 180)
  --request-timeout    Per-request fetch timeout in seconds (default: 30)
  --json-only          Suppress human-readable stderr output; emit only JSON to stdout
  --skip-cleanup       Do not remove test channels after the test
  --help               Show this message

FLOW
  1. Ensure sandbox is running (pre-check)
  2. Configure test channels via PUT /api/admin/channel-secrets
  3. Stop the sandbox via POST /api/admin/stop
  4. Wait for status to become "stopped"
  5. Send a synthetic Telegram webhook via POST /api/admin/channel-secrets
  6. Poll /api/status until sandbox is "running"
  7. Poll /api/admin/channel-forward-diag for the timing trace
  8. Clean up test channels via DELETE /api/admin/channel-secrets
  9. Report timing breakdown and exit

EXIT CODES
  0 — success (wake + message delivery confirmed)
  1 — failure (timeout, message lost, or error)
  2 — bad arguments
`);
  process.exit(0);
}

const baseUrl = values["base-url"]?.trim();
if (!baseUrl) {
  process.stderr.write("error: --base-url is required\n");
  process.exit(2);
}

const adminSecret =
  values["admin-secret"]?.trim() || process.env.ADMIN_SECRET?.trim() || "";
const authCookie =
  values["auth-cookie"]?.trim() || process.env.SMOKE_AUTH_COOKIE?.trim() || "";
const bypass =
  values["protection-bypass"]?.trim() ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ||
  "";

if (!adminSecret && !authCookie) {
  process.stderr.write(
    "error: --admin-secret or --auth-cookie is required (or set ADMIN_SECRET / SMOKE_AUTH_COOKIE env vars)\n",
  );
  process.exit(2);
}

const timeoutSec = Number.parseInt(values.timeout, 10);
if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
  process.stderr.write("error: --timeout must be a positive integer\n");
  process.exit(2);
}
const timeoutMs = timeoutSec * 1000;

const requestTimeoutMs =
  Number.parseInt(values["request-timeout"], 10) * 1000;
const jsonOnly = values["json-only"];
const skipCleanup = values["skip-cleanup"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  if (!jsonOnly) {
    process.stderr.write(`[telegram-wake] ${msg}\n`);
  }
}

function buildUrl(path) {
  const u = new URL(path, baseUrl);
  if (bypass) {
    u.searchParams.set("x-vercel-protection-bypass", bypass);
  }
  return u.href;
}

function buildHeaders(mutation = false) {
  const headers = {
    "content-type": "application/json",
  };
  if (mutation) {
    headers["x-requested-with"] = "XMLHttpRequest";
    headers["origin"] = new URL(baseUrl).origin;
  }
  if (adminSecret) {
    headers["authorization"] = `Bearer ${adminSecret}`;
  }
  if (authCookie) {
    headers["cookie"] = authCookie;
  }
  return headers;
}

async function fetchJson(path, opts = {}) {
  const u = buildUrl(path);
  const timeout = opts.timeoutMs ?? requestTimeoutMs;
  const response = await fetch(u, {
    method: opts.method ?? "GET",
    headers: opts.headers ?? buildHeaders(opts.mutation ?? false),
    body: opts.body ?? undefined,
    signal: AbortSignal.timeout(timeout),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTelegramPayload() {
  const updateId = Math.floor(Math.random() * 1_000_000_000);
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      text: "/ask smoke-test: reply with exactly smoke-ok",
      chat: { id: 999_999_999, type: "private" },
      from: { id: 999_999_998, is_bot: false, first_name: "SmokeTest" },
      date: Math.floor(Date.now() / 1000),
    },
  });
}

async function configureTestChannels() {
  log("phase: configuring smoke test channels...");
  const res = await fetchJson("/api/admin/channel-secrets", {
    method: "PUT",
    mutation: true,
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(
      `configure test channels failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  log("smoke test channels configured");
  return res.body;
}

async function cleanupTestChannels() {
  log("phase: cleaning up smoke test channels...");
  const res = await fetchJson("/api/admin/channel-secrets", {
    method: "DELETE",
    mutation: true,
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(
      `cleanup test channels failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  log("smoke test channels removed");
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function ensureRunning() {
  log("phase: ensure sandbox is running (pre-check)...");
  const res = await fetchJson("/api/admin/ensure?wait=1&timeoutMs=240000", {
    method: "POST",
    mutation: true,
    timeoutMs: 250_000,
  });
  if (!res.ok) {
    throw new Error(
      `pre-check ensure failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  log(`pre-check: sandbox running, status=${res.body?.status}`);
  return res.body;
}

async function ensureTelegramConfigured() {
  log("phase: verifying Telegram is configured...");
  const res = await fetchJson("/api/channels/summary");
  if (!res.ok) {
    throw new Error(
      `channel summary failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  const tg = res.body?.telegram;
  if (tg?.configured) {
    log(`Telegram: configured=${tg.configured} status=${tg.status}`);
    return { configuredByUs: false, summary: res.body };
  }

  log("Telegram is not configured; falling back to smoke test channel config");
  await configureTestChannels();

  const retry = await fetchJson("/api/channels/summary");
  if (!retry.ok) {
    throw new Error(
      `channel summary retry failed: HTTP ${retry.status} ${JSON.stringify(retry.body)}`,
    );
  }

  const retryTelegram = retry.body?.telegram;
  if (!retryTelegram?.configured) {
    throw new Error("Telegram smoke test channel setup did not produce a configured Telegram channel");
  }

  log(`Telegram: configured=${retryTelegram.configured} status=${retryTelegram.status}`);
  return { configuredByUs: true, summary: retry.body };
}

async function stopSandbox() {
  log("phase: stopping sandbox...");
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  let delay = 500;

  while (Date.now() < deadline) {
    attempt += 1;
    const res = await fetchJson("/api/admin/stop", {
      method: "POST",
      mutation: true,
    });
    if (res.ok) {
      log(`sandbox stop initiated${attempt > 1 ? ` after retry ${attempt}` : ""}`);
      return res.body;
    }

    const errorCode = res.body?.error;
    const lifecycleLockUnavailable =
      res.status === 500 && errorCode === "INTERNAL_ERROR";

    if (!lifecycleLockUnavailable || Date.now() + delay >= deadline) {
      throw new Error(
        `stop failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
      );
    }

    log(
      `stop attempt ${attempt} hit lifecycle lock contention; retrying in ${delay}ms`,
    );
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 2_000);
  }

  throw new Error("stop failed: lifecycle lock contention did not clear within 20s");
}

async function waitForStopped() {
  log("phase: waiting for stopped status...");
  const deadline = Date.now() + 60_000;
  let delay = 1_000;
  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/status");
      if (res.body?.status === "stopped") {
        log("sandbox is stopped");
        return;
      }
      log(`  status: ${res.body?.status}`);
    } catch {
      // ignore transient errors
    }
    delay = Math.min(delay * 1.3, 5_000);
  }
  throw new Error("sandbox did not reach 'stopped' within 60s");
}

async function sendTelegramWebhook() {
  log("phase: sending synthetic Telegram webhook while stopped...");
  const payload = buildTelegramPayload();
  const res = await fetchJson("/api/admin/channel-secrets", {
    method: "POST",
    mutation: true,
    body: JSON.stringify({ channel: "telegram", body: payload }),
  });
  if (!res.ok) {
    throw new Error(
      `send webhook failed: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  if (!res.body?.sent) {
    if (res.body?.configured === false) {
      throw new Error("Telegram channel not configured (configured=false)");
    }
    throw new Error(
      `webhook not sent: ${JSON.stringify(res.body)}`,
    );
  }
  log(`webhook dispatched: sent=${res.body.sent} status=${res.body.status}`);
  return res.body;
}

async function waitForRunning() {
  log("phase: polling for sandbox to wake up...");
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let delay = 3_000;
  let lastDiag = null;
  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/status");
      const status = res.body?.status;
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (status === "running") {
        log(`sandbox woke up after ${elapsed}s`);
        return { wakeMs: Date.now() - t0 };
      }
      log(`  status=${status} elapsed=${elapsed}s`);
    } catch {
      // ignore transient errors
    }

    // Local next dev + workflow execution can leave /api/status on stale
    // in-memory metadata even after the workflow has finished.  When that
    // happens, treat a completed channel-forward diagnostic as the source
    // of truth that the wake path succeeded.
    try {
      const diagRes = await fetchJson("/api/admin/channel-forward-diag");
      if (diagRes.ok && diagRes.body && !diagRes.body.error) {
        lastDiag = diagRes.body;
        if (
          diagRes.body.outcome === "success" ||
          diagRes.body.forwardOk === true
        ) {
          log(
            `wake confirmed by diagnostic after ${Math.round(
              (Date.now() - t0) / 1000,
            )}s`,
          );
          return {
            wakeMs: Date.now() - t0,
            viaDiagnostic: true,
            diag: diagRes.body,
          };
        }
      }
    } catch {
      // ignore diag polling errors
    }

    delay = Math.min(delay * 1.3, 10_000);
  }

  if (lastDiag?.outcome || lastDiag?.forwardOk != null) {
    throw new Error(
      `sandbox status never became running within ${timeoutSec}s; last diagnostic was ${JSON.stringify(lastDiag)}`,
    );
  }

  throw new Error(
    `sandbox did not wake up within ${timeoutSec}s — message may be lost`,
  );
}

async function readDiag() {
  log("phase: reading channel-forward-diag...");
  // The workflow may still be writing the diag; poll for a short window
  const deadline = Date.now() + 30_000;
  let delay = 2_000;
  let lastDiag = null;

  while (Date.now() < deadline) {
    await sleep(delay);
    try {
      const res = await fetchJson("/api/admin/channel-forward-diag");
      if (res.ok && res.body && !res.body.error) {
        lastDiag = res.body;
        // If the diag has a completedAt, it's done
        if (res.body.completedAt || res.body.outcome) {
          log(`diag available: outcome=${res.body.outcome}`);
          return res.body;
        }
      }
    } catch {
      // ignore
    }
    delay = Math.min(delay * 1.5, 5_000);
  }

  // Return whatever we got, even if incomplete
  if (lastDiag) {
    log("diag retrieved (may be incomplete)");
    return lastDiag;
  }
  log("no diag data available");
  return null;
}

async function removeTestChannels() {
  log("phase: cleaning up test channels...");
  try {
    await fetchJson("/api/admin/channel-secrets", {
      method: "DELETE",
      mutation: true,
    });
    log("test channels removed");
  } catch {
    log("warning: test channel cleanup failed (best effort)");
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatTimingBreakdown(diag) {
  if (!diag) return "  (no diagnostic data available)";

  const lines = [];
  const ms = (v) => (typeof v === "number" ? `${v}ms` : "n/a");

  lines.push(`  outcome:            ${diag.outcome ?? "unknown"}`);
  lines.push(`  channel:            ${diag.channel ?? "unknown"}`);
  lines.push(`  total duration:     ${ms(diag.totalDurationMs)}`);
  lines.push("");
  lines.push("  Boot phase:");
  lines.push(`    boot duration:    ${ms(diag.bootDurationMs)}`);
  lines.push(`    boot status:      ${diag.bootResultStatus ?? "n/a"}`);
  lines.push(`    boot message:     ${diag.bootMessageSent ?? "n/a"}`);
  lines.push("");
  lines.push("  Sandbox readiness:");
  lines.push(`    status:           ${diag.readyMetaStatus ?? "n/a"}`);
  lines.push(`    sandboxId:        ${diag.readyMetaSandboxId ?? "n/a"}`);
  lines.push(`    used boot meta:   ${diag.usedBootMetaDirectly ?? "n/a"}`);
  lines.push("");
  lines.push("  Telegram probe:");
  lines.push(`    attempts:         ${diag.telegramProbeAttempts ?? "n/a"}`);
  lines.push(`    wait:             ${ms(diag.telegramProbeWaitMs)}`);
  lines.push(`    last status:      ${diag.telegramProbeLastStatus ?? "n/a"}`);
  lines.push("");
  lines.push("  Forward:");
  lines.push(`    ok:               ${diag.forwardOk ?? "n/a"}`);
  lines.push(`    status:           ${diag.forwardStatus ?? "n/a"}`);
  lines.push(`    duration:         ${ms(diag.forwardDurationMs)}`);
  lines.push(`    attempts:         ${diag.forwardAttempts ?? "n/a"}`);
  lines.push(`    total (retries):  ${ms(diag.forwardTotalMs)}`);

  if (diag.error) {
    lines.push("");
    lines.push(`  error:              ${diag.error}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  let configuredByUs = false;
  let result;

  try {
    // 1. Pre-check: sandbox must be running
    await ensureRunning();

    // 2. Verify Telegram is configured, or auto-configure smoke credentials
    const configState = await ensureTelegramConfigured();
    configuredByUs = configState.configuredByUs;

    // 3. Stop the sandbox
    await stopSandbox();

    // 4. Wait for stopped
    await waitForStopped();
    const stoppedAt = Date.now();

    // 5. Send synthetic Telegram webhook
    const webhookResult = await sendTelegramWebhook();
    const webhookSentAt = Date.now();

    // 6. Poll until running
    const wakeResult = await waitForRunning();
    const runningAt = Date.now();

    // 7. Read diagnostic
    const diag = await readDiag();
    const diagReadAt = Date.now();

    // 8. Build result
    const totalMs = diagReadAt - t0;
    const stopToWebhookMs = webhookSentAt - stoppedAt;
    const webhookToRunningMs = runningAt - webhookSentAt;
    const passed =
      diag?.outcome === "success" || (diag?.forwardOk === true);

    result = {
      schemaVersion: 1,
      type: "telegram-wake-test",
      passed,
      generatedAt: new Date().toISOString(),
      baseUrl,
      timing: {
        totalMs,
        stopToWebhookMs,
        webhookToRunningMs,
        wakeMs: wakeResult.wakeMs,
        diagReadMs: diagReadAt - runningAt,
      },
      webhook: webhookResult,
      diag: diag ?? null,
      error: passed ? null : (diag?.error ?? "diag outcome was not success"),
    };

    if (!jsonOnly) {
      process.stderr.write("\n=== TELEGRAM WAKE-FROM-SLEEP TEST ===\n\n");
      process.stderr.write(
        `  result:             ${passed ? "PASS" : "FAIL"}\n`,
      );
      process.stderr.write(`  total wall time:    ${totalMs}ms\n`);
      process.stderr.write(`  stop -> webhook:    ${stopToWebhookMs}ms\n`);
      process.stderr.write(
        `  webhook -> running: ${webhookToRunningMs}ms\n`,
      );
      process.stderr.write(`  wake latency:       ${wakeResult.wakeMs}ms\n`);
      process.stderr.write("\n--- Channel Forward Diagnostic ---\n\n");
      process.stderr.write(formatTimingBreakdown(diag) + "\n\n");
    }

    console.log(JSON.stringify(result, null, jsonOnly ? 0 : 2));
    return passed ? 0 : 1;
  } catch (err) {
    const totalMs = Date.now() - t0;
    result = {
      schemaVersion: 1,
      type: "telegram-wake-test",
      passed: false,
      generatedAt: new Date().toISOString(),
      baseUrl,
      timing: { totalMs },
      error: err.message,
    };

    if (!jsonOnly) {
      process.stderr.write(`\n=== TELEGRAM WAKE-FROM-SLEEP TEST ===\n\n`);
      process.stderr.write(`  result:  FAIL\n`);
      process.stderr.write(`  error:   ${err.message}\n`);
      process.stderr.write(`  elapsed: ${totalMs}ms\n\n`);
    }

    console.error(JSON.stringify(result, null, jsonOnly ? 0 : 2));
    return 1;
  } finally {
    if (configuredByUs && !skipCleanup) {
      try {
        await cleanupTestChannels();
      } catch (cleanupError) {
        if (!jsonOnly) {
          process.stderr.write(
            `[telegram-wake] cleanup warning: ${cleanupError.message}\n`,
          );
        }
      }
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
