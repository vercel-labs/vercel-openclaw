#!/usr/bin/env tsx
/**
 * Remote smoke runner CLI.
 *
 * Hits a live deployed instance over HTTP and produces a structured
 * pass/fail report. No external CLI dependencies — uses node:parseArgs.
 *
 * Usage:
 *   npm run smoke:remote --base-url https://my-app.vercel.app
 *   npm run smoke:remote --base-url https://my-app.vercel.app --destructive --timeout 180
 *
 * Environment:
 *   SMOKE_AUTH_COOKIE — encrypted session cookie for sign-in-with-vercel mode
 */

import { parseArgs } from "node:util";

import type { PhaseResult } from "./remote-phases.js";
import {
  health,
  status,
  gatewayProbe,
  firewallRead,
  channelsSummary,
  sshEcho,
  chatCompletions,
  channelRoundTrip,
  channelWakeFromSleep,
  codexStatus,
  codexChatCompletions,
  codexWakeFromSleep,
  ensureRunning,
  snapshotStop as _snapshotStop,
  restoreFromSnapshot as _restoreFromSnapshot,
  selfHealTokenRefresh,
} from "./remote-phases.js";
import { setAuthCookie, setProtectionBypass, getAuthSource } from "./remote-auth.js";
import { emitEvent } from "./log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmokeReport {
  schemaVersion: 1;
  passed: boolean;
  phases: PhaseResult[];
  totalMs: number;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseCliArgs(): {
  baseUrl: string;
  destructive: boolean;
  timeoutMs: number;
  requestTimeoutMs: number;
  jsonOnly: boolean;
} {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      destructive: { type: "boolean", default: false },
      timeout: { type: "string", default: "120" },
      "request-timeout": { type: "string", default: "30" },
      "auth-cookie": { type: "string" },
      "protection-bypass": { type: "string" },
      "json-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.error(`Usage: remote-smoke --base-url <url> [options]

Options:
  --base-url              Required. The deployed app URL to test.
  --destructive           Run destructive phases (ensure, snapshot, restore).
  --timeout <seconds>     Timeout in seconds for polling phases (default: 120).
  --request-timeout <s>   Per-request fetch timeout in seconds (default: 30).
  --auth-cookie <value>   Auth cookie (overrides SMOKE_AUTH_COOKIE env var).
  --protection-bypass <s> Vercel deployment protection bypass secret
                          (overrides VERCEL_AUTOMATION_BYPASS_SECRET env var).
  --json-only             Suppress human-readable stderr; emit only JSON to stdout.
  --help                  Show this help message.

Phases:
  Safe (always run):      health, status, gatewayProbe, firewallRead,
                          channelsSummary, sshEcho, codexStatus,
                          chatCompletions, channelRoundTrip
  Destructive (opt-in):   ensureRunning, chatCompletions, channelRoundTrip,
                          codexChatCompletions, codexWakeFromSleep,
                          channelWakeFromSleep, chatCompletions (post-wake),
                          selfHealTokenRefresh (slack/telegram/discord)

  Codex phases skip gracefully when Codex credentials are not configured
  on the target deployment. They never log tokens.

Environment:
  SMOKE_AUTH_COOKIE                  Encrypted session cookie for sign-in-with-vercel mode.
  VERCEL_AUTOMATION_BYPASS_SECRET    Deployment protection bypass secret.`);
    process.exit(0);
  }

  if (!values["base-url"]) {
    console.error("error: --base-url is required");
    process.exit(1);
  }

  const timeoutSec = Number(values.timeout);
  if (Number.isNaN(timeoutSec) || timeoutSec <= 0) {
    console.error("error: --timeout must be a positive number");
    process.exit(1);
  }

  const requestTimeoutSec = Number(values["request-timeout"]);
  if (Number.isNaN(requestTimeoutSec) || requestTimeoutSec <= 0) {
    console.error("error: --request-timeout must be a positive number");
    process.exit(1);
  }

  // Apply auth overrides (CLI flags take precedence over env vars)
  if (values["auth-cookie"]) {
    setAuthCookie(values["auth-cookie"]);
  }
  if (values["protection-bypass"]) {
    setProtectionBypass(values["protection-bypass"]);
  }

  return {
    baseUrl: values["base-url"],
    destructive: values.destructive ?? false,
    timeoutMs: timeoutSec * 1000,
    requestTimeoutMs: requestTimeoutSec * 1000,
    jsonOnly: values["json-only"] ?? false,
  };
}

// ---------------------------------------------------------------------------
// Phase runner
// ---------------------------------------------------------------------------

type PhaseFn = (baseUrl: string, timeoutMs: number, requestTimeoutMs: number) => Promise<PhaseResult>;

function buildPhaseList(destructive: boolean): PhaseFn[] {
  const safe: PhaseFn[] = [
    (b, _t, r) => health(b, { requestTimeoutMs: r }),
    (b, _t, r) => status(b, { requestTimeoutMs: r }),
    (b, _t, r) => gatewayProbe(b, { requestTimeoutMs: r }),
    (b, _t, r) => firewallRead(b, { requestTimeoutMs: r }),
    (b, _t, r) => channelsSummary(b, { requestTimeoutMs: r }),
    (b, _t, r) => sshEcho(b, { requestTimeoutMs: r }),
    // codexStatus is read-only — passes when Codex is unconfigured or
    // when configured and the response shape is well-formed.
    (b, _t, r) => codexStatus(b, { requestTimeoutMs: r }),
    // chatCompletions needs a running sandbox — gracefully fails with
    // SANDBOX_NOT_READY (202) if sandbox is not running.
    (b, _t, _r) => chatCompletions(b, { requestTimeoutMs: 60_000 }),
    // channelRoundTrip gracefully skips if no channels are configured.
    (b, t, _r) => channelRoundTrip(b, { requestTimeoutMs: 30_000, pollTimeoutMs: t }),
  ];

  if (!destructive) return safe;

  const destroy: PhaseFn[] = [
    // Ensure sandbox is running for initial tests
    (b, t, r) => ensureRunning(b, t, { requestTimeoutMs: r }),
    // Test completions + channels while running
    (b, _t, _r) => chatCompletions(b, { requestTimeoutMs: 60_000 }),
    (b, t, _r) => channelRoundTrip(b, { requestTimeoutMs: 30_000, pollTimeoutMs: t }),
    // Codex probes — skip gracefully when Codex creds aren't pasted.
    (b, _t, _r) => codexChatCompletions(b, { requestTimeoutMs: 60_000 }),
    (b, t, _r) => codexWakeFromSleep(b, t, { requestTimeoutMs: 30_000 }),
    // Stop sandbox, then test channel-triggered wake-up
    // channelWakeFromSleep stops the sandbox internally if needed,
    // sends a webhook, and verifies the sandbox wakes up and drains
    (b, t, _r) => channelWakeFromSleep(b, t, { requestTimeoutMs: 30_000 }),
    // Verify the woken sandbox can still answer questions
    (b, _t, _r) => chatCompletions(b, { requestTimeoutMs: 60_000 }),
    // Self-healing: corrupt the gateway token, send a channel webhook,
    // and verify the shared pipeline self-repairs for each channel
    (b, t, _r) => selfHealTokenRefresh(b, t, "slack", { requestTimeoutMs: 30_000 }),
    (b, t, _r) => selfHealTokenRefresh(b, t, "telegram", { requestTimeoutMs: 30_000 }),
    (b, t, _r) => selfHealTokenRefresh(b, t, "discord", { requestTimeoutMs: 30_000 }),
  ];

  return [...safe, ...destroy];
}

async function runPhases(
  baseUrl: string,
  timeoutMs: number,
  requestTimeoutMs: number,
  phases: PhaseFn[],
  jsonOnly: boolean,
): Promise<SmokeReport> {
  const t0 = performance.now();
  const results: PhaseResult[] = [];

  for (const fn of phases) {
    // We don't know the phase name ahead of time, but we can emit a
    // generic start event. The phase name comes from the result.
    const result = await fn(baseUrl, timeoutMs, requestTimeoutMs);
    results.push(result);

    // Structured event: phase-end (always emitted)
    emitEvent({
      type: "phase-end",
      timestamp: new Date().toISOString(),
      phase: result.phase,
      passed: result.passed,
      durationMs: result.durationMs,
      result,
    });

    // Human-readable progress (only when not --json-only)
    if (!jsonOnly) {
      const icon = result.passed ? "PASS" : "FAIL";
      console.error(
        `  [${icon}] ${result.phase} (${result.durationMs}ms)${result.error ? ` — ${result.error}` : ""}`,
      );
    }
  }

  const totalMs = Math.round(performance.now() - t0);
  const passed = results.every((r) => r.passed);
  return { schemaVersion: 1, passed, phases: results, totalMs };
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

function printSummary(report: SmokeReport): void {
  console.error("");
  console.error("─── Smoke Report ───");
  const passCount = report.phases.filter((p) => p.passed).length;
  const failCount = report.phases.length - passCount;
  console.error(
    `  ${passCount} passed, ${failCount} failed, ${report.totalMs}ms total`,
  );
  if (report.passed) {
    console.error("  Result: ALL PASSED");
  } else {
    const failed = report.phases.filter((p) => !p.passed).map((p) => p.phase);
    console.error(`  Result: FAILED [${failed.join(", ")}]`);
  }
  console.error("────────────────────");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { baseUrl, destructive, timeoutMs, requestTimeoutMs, jsonOnly } = parseCliArgs();

  // Structured event: smoke-start (always emitted)
  emitEvent({
    type: "smoke-start",
    timestamp: new Date().toISOString(),
    baseUrl,
    destructive,
    timeoutMs,
    requestTimeoutMs,
    authSource: getAuthSource(),
  });

  const phases = buildPhaseList(destructive);
  const report = await runPhases(baseUrl, timeoutMs, requestTimeoutMs, phases, jsonOnly);

  // Structured event: smoke-finish (always emitted)
  const passedCount = report.phases.filter((p) => p.passed).length;
  emitEvent({
    type: "smoke-finish",
    timestamp: new Date().toISOString(),
    passed: report.passed,
    phaseCount: report.phases.length,
    passedCount,
    failedCount: report.phases.length - passedCount,
    totalMs: report.totalMs,
  });

  if (!jsonOnly) {
    printSummary(report);
  }

  // Structured JSON report to stdout (machine-readable)
  console.log(JSON.stringify(report, null, 2));

  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  emitEvent({
    type: "fatal",
    timestamp: new Date().toISOString(),
    error: err instanceof Error ? err.message : String(err),
  });
  console.error("fatal:", err);
  process.exit(2);
});
