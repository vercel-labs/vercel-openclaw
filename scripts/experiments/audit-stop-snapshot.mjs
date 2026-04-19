#!/usr/bin/env node
/**
 * Audit experiment: stop/snapshot behavior
 *
 * Answers:
 *   Q1  — Snapshot timing on ~50MB sandboxes (3 iterations).
 *   Q5  — Stale threshold: measure blocking vs non-blocking stop().
 *   Q13 — Concurrent create during snapshot() — does it interfere?
 *   Q14 — Pending-status behavior: runCommand against a freshly-created sandbox.
 *
 * Usage:
 *   node scripts/experiments/audit-stop-snapshot.mjs
 */

import { readFileSync } from "node:fs";

// ── env.local loader ────────────────────────────────────────────────────────
const content = readFileSync(
  new URL("../../.env.local", import.meta.url),
  "utf-8",
);
for (const line of content.split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq);
  let v = t.slice(eq + 1);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}

const { Sandbox } = await import("@vercel/sandbox");

function ms(start) {
  return Math.round(performance.now() - start);
}

function log(event, data) {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n");
}

async function safeStop(sandbox, label) {
  if (!sandbox) return;
  try {
    await sandbox.stop();
    log("cleanup.ok", { label, sandboxId: sandbox.sandboxId });
  } catch (err) {
    log("cleanup.error", { label, sandboxId: sandbox.sandboxId, error: String(err?.message ?? err) });
  }
}

function pickSnapshotId(snap) {
  return snap?.snapshotId ?? snap?.snapshot?.id ?? snap?.id ?? null;
}

function pickSnapshotBytes(snap) {
  return (
    snap?.sizeBytes ??
    snap?.size ??
    snap?.snapshot?.sizeBytes ??
    snap?.snapshot?.size ??
    null
  );
}

// Writes ~50MB of random data split across many files to simulate realistic FS.
async function fill50MB(sandbox) {
  const start = performance.now();
  // dd random data: 50 × 1MB files
  const script = `
set -e
mkdir -p /tmp/fill
for i in $(seq 1 50); do
  dd if=/dev/urandom of=/tmp/fill/chunk-$i bs=1M count=1 status=none
done
du -sb /tmp/fill | awk '{print $1}'
`;
  const result = await sandbox.runCommand("sh", ["-c", script], { timeout: 120_000 });
  const out = (await result.output("stdout")).trim();
  const bytes = Number(out) || null;
  return { ms: ms(start), exitCode: result.exitCode, bytes };
}

// ── Q1: Snapshot timing ─────────────────────────────────────────────────────
async function q1SnapshotTiming(iterations = 3) {
  log("q1.start", { iterations });
  const results = [];
  for (let i = 0; i < iterations; i++) {
    let sandbox;
    try {
      const createStart = performance.now();
      sandbox = await Sandbox.create({ timeout: 180_000 });
      const createMs = ms(createStart);
      log("q1.created", { i, createMs, sandboxId: sandbox.sandboxId });

      const fill = await fill50MB(sandbox);
      log("q1.filled", { i, ...fill });

      const snapStart = performance.now();
      const snap = await sandbox.snapshot();
      const snapshotMs = ms(snapStart);
      const snapshotId = pickSnapshotId(snap);
      const sizeBytes = pickSnapshotBytes(snap);
      log("q1.snapshot", { i, snapshotMs, snapshotId, sizeBytes });

      results.push({ iteration: i, createMs, fillMs: fill.ms, snapshotMs, sizeBytes, snapshotId });
    } catch (err) {
      log("q1.error", { i, error: String(err?.message ?? err) });
      results.push({ iteration: i, error: String(err?.message ?? err) });
    } finally {
      await safeStop(sandbox, `q1.iter.${i}`);
    }
  }
  log("q1.done", { results });
  return results;
}

// ── Q5: Stale threshold — blocking vs non-blocking stop ─────────────────────
async function q5StopTiming() {
  log("q5.start", {});
  const result = { blocking: null, nonBlocking: null };

  // Blocking
  {
    let sandbox;
    try {
      sandbox = await Sandbox.create({ timeout: 120_000 });
      log("q5.blocking.created", { sandboxId: sandbox.sandboxId });
      const cmd = await sandbox.runCommand("sh", ["-c", "echo setup-done && sleep 1"], { timeout: 30_000 });
      log("q5.blocking.setup", { exitCode: cmd.exitCode });

      const stopStart = performance.now();
      await sandbox.stop({ blocking: true });
      const stopMs = ms(stopStart);
      log("q5.blocking.stop", { stopMs });

      // Confirm status
      let postStatus = null;
      try {
        const refreshed = await Sandbox.get({ sandboxId: sandbox.sandboxId });
        postStatus = refreshed?.status ?? refreshed?.state ?? null;
      } catch (err) {
        postStatus = `error:${String(err?.message ?? err)}`;
      }
      result.blocking = { stopMs, postStatus };
    } catch (err) {
      log("q5.blocking.error", { error: String(err?.message ?? err) });
      result.blocking = { error: String(err?.message ?? err) };
    }
    // No finally stop — already stopped.
  }

  // Non-blocking + poll
  {
    let sandbox;
    try {
      sandbox = await Sandbox.create({ timeout: 120_000 });
      log("q5.nonblocking.created", { sandboxId: sandbox.sandboxId });
      await sandbox.runCommand("sh", ["-c", "echo setup-done"], { timeout: 30_000 });

      const stopStart = performance.now();
      await sandbox.stop({ blocking: false });
      const issuedMs = ms(stopStart);
      log("q5.nonblocking.issued", { issuedMs });

      const pollResults = [];
      const pollDeadline = performance.now() + 60_000;
      let terminalStatus = null;
      let terminalMs = null;
      while (performance.now() < pollDeadline) {
        const tPoll = performance.now();
        let status = null;
        try {
          const refreshed = await Sandbox.get({ sandboxId: sandbox.sandboxId });
          status = refreshed?.status ?? refreshed?.state ?? null;
        } catch (err) {
          status = `error:${String(err?.message ?? err)}`;
        }
        const elapsed = ms(stopStart);
        pollResults.push({ elapsed, pollMs: ms(tPoll), status });
        log("q5.nonblocking.poll", { elapsed, status });
        if (status && status !== "running" && status !== "pending" && !String(status).startsWith("error:")) {
          terminalStatus = status;
          terminalMs = elapsed;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      result.nonBlocking = { issuedMs, terminalStatus, terminalMs, pollResults };
    } catch (err) {
      log("q5.nonblocking.error", { error: String(err?.message ?? err) });
      result.nonBlocking = { error: String(err?.message ?? err) };
    }
  }

  log("q5.done", result);
  return result;
}

// ── Q13: Concurrent create during snapshot ──────────────────────────────────
async function q13ConcurrentCreateDuringSnapshot() {
  log("q13.start", {});
  let subject, second;
  try {
    subject = await Sandbox.create({ timeout: 120_000 });
    log("q13.subject.created", { sandboxId: subject.sandboxId });
    const fill = await fill50MB(subject);
    log("q13.subject.filled", fill);

    // Kick off snapshot, then *immediately* start a second create.
    const snapStart = performance.now();
    const snapPromise = subject.snapshot();

    const secondStart = performance.now();
    const secondPromise = Sandbox.create({ timeout: 120_000 });

    // Await both with timing.
    let snap, snapshotMs, snapErr;
    try {
      snap = await snapPromise;
      snapshotMs = ms(snapStart);
    } catch (err) {
      snapErr = String(err?.message ?? err);
      snapshotMs = ms(snapStart);
    }

    let createMs, createErr;
    try {
      second = await secondPromise;
      createMs = ms(secondStart);
    } catch (err) {
      createErr = String(err?.message ?? err);
      createMs = ms(secondStart);
    }

    log("q13.snapshot", { snapshotMs, snapshotId: snap ? pickSnapshotId(snap) : null, sizeBytes: snap ? pickSnapshotBytes(snap) : null, error: snapErr });
    log("q13.secondCreate", { createMs, sandboxId: second?.sandboxId ?? null, error: createErr });

    // Verify second sandbox actually works.
    let secondAlive = null;
    if (second) {
      try {
        const check = await second.runCommand("echo", ["alive"], { timeout: 15_000 });
        secondAlive = (await check.output("stdout")).trim() === "alive";
      } catch (err) {
        secondAlive = `error:${String(err?.message ?? err)}`;
      }
    }
    log("q13.secondLiveness", { secondAlive });

    const res = {
      snapshotMs,
      snapError: snapErr ?? null,
      secondCreateMs: createMs,
      secondCreateError: createErr ?? null,
      secondAlive,
      order: snapshotMs <= createMs ? "snapshot-first" : "create-first",
    };
    log("q13.done", res);
    return res;
  } finally {
    await safeStop(subject, "q13.subject");
    await safeStop(second, "q13.second");
  }
}

// ── Q14: Pending-status runCommand ──────────────────────────────────────────
async function q14PendingRunCommand() {
  log("q14.start", {});
  let sandbox;
  try {
    const createStart = performance.now();
    // Don't await — run a race against immediate runCommand.
    const createPromise = Sandbox.create({ timeout: 120_000 });

    // As soon as we have the handle, attempt runCommand.
    sandbox = await createPromise;
    const handleMs = ms(createStart);
    log("q14.handle", { handleMs, sandboxId: sandbox.sandboxId });

    // Some SDKs expose .status — capture if available.
    const rawStatus = sandbox.status ?? sandbox.state ?? null;
    log("q14.handleStatus", { rawStatus });

    // Immediate runCommand with AbortSignal timeout.
    const runStart = performance.now();
    let runResult = { ok: false };
    try {
      const abort = AbortSignal.timeout(10_000);
      const cmd = await sandbox.runCommand("echo", ["hello-from-pending"], {
        timeout: 10_000,
        signal: abort,
      });
      const out = (await cmd.output("stdout")).trim();
      runResult = {
        ok: true,
        runMs: ms(runStart),
        exitCode: cmd.exitCode,
        stdout: out,
      };
    } catch (err) {
      runResult = {
        ok: false,
        runMs: ms(runStart),
        error: String(err?.message ?? err),
        name: err?.name ?? null,
      };
    }
    log("q14.runImmediate", runResult);

    // Follow-up: does a normal runCommand succeed afterwards?
    let secondRun = null;
    try {
      const cmd2 = await sandbox.runCommand("echo", ["hello-again"], { timeout: 15_000 });
      secondRun = {
        ok: true,
        exitCode: cmd2.exitCode,
        stdout: (await cmd2.output("stdout")).trim(),
      };
    } catch (err) {
      secondRun = { ok: false, error: String(err?.message ?? err) };
    }
    log("q14.runFollowup", secondRun);

    const res = { handleMs, rawStatus, runImmediate: runResult, runFollowup: secondRun };
    log("q14.done", res);
    return res;
  } finally {
    await safeStop(sandbox, "q14");
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const summary = { startedAt: new Date().toISOString(), tests: {} };

  try {
    summary.tests.q1 = await q1SnapshotTiming(3);
  } catch (err) {
    summary.tests.q1 = { error: String(err?.message ?? err) };
  }

  try {
    summary.tests.q5 = await q5StopTiming();
  } catch (err) {
    summary.tests.q5 = { error: String(err?.message ?? err) };
  }

  try {
    summary.tests.q13 = await q13ConcurrentCreateDuringSnapshot();
  } catch (err) {
    summary.tests.q13 = { error: String(err?.message ?? err) };
  }

  try {
    summary.tests.q14 = await q14PendingRunCommand();
  } catch (err) {
    summary.tests.q14 = { error: String(err?.message ?? err) };
  }

  summary.finishedAt = new Date().toISOString();
  process.stdout.write("\n=== FINAL SUMMARY ===\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

await main();
