#!/usr/bin/env node
/**
 * Audit experiment: persistent sandbox stop → snapshot → resume cycle
 *
 * This is the critical path for the entire app — every user session depends on
 * stop({ blocking: false }) producing a snapshot that get() can later resume.
 *
 * Tests:
 *   1. Create persistent sandbox, write a marker file
 *   2. stop({ blocking: false }) — record immediate status
 *   3. Poll Sandbox.get() every 500ms — track status transitions until "stopped"
 *   4. Resume via Sandbox.get() — verify sandbox is running and marker file persists
 *   5. stop({ blocking: true }) — measure total blocking time
 *   6. Delete the persistent sandbox to clean up
 *
 * Usage:
 *   node scripts/experiments/audit-persistent-stop-resume.mjs
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

function log(event, data = {}) {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n");
}

const MARKER_PATH = "/tmp/audit-marker.txt";
const MARKER_CONTENT = `audit-${randomUUID()}`;
const SANDBOX_NAME = `oc-audit-${Date.now()}`;
const POLL_INTERVAL_MS = 500;
const MAX_POLL_MS = 120_000;

let sandbox = null;

try {
  // ── Step 1: Create persistent sandbox ──────────────────────────────────
  log("step1.create.start", { name: SANDBOX_NAME });
  const createStart = performance.now();
  sandbox = await Sandbox.create({
    name: SANDBOX_NAME,
    persistent: true,
    timeout: 5 * 60_000,
    resources: { vcpus: 1 },
  });
  log("step1.create.done", {
    createMs: ms(createStart),
    sandboxId: sandbox.sandboxId,
    status: sandbox.status,
  });

  // Write marker file
  await sandbox.writeFiles([
    { path: MARKER_PATH, content: Buffer.from(MARKER_CONTENT) },
  ]);
  const verifyResult = await sandbox.runCommand("cat", [MARKER_PATH]);
  const markerVerified = (await verifyResult.output("stdout")).trim() === MARKER_CONTENT;
  log("step1.marker.written", { markerVerified, marker: MARKER_CONTENT });

  // Write ~10MB to give the snapshot real filesystem work
  const fillResult = await sandbox.runCommand("bash", [
    "-c",
    "dd if=/dev/urandom of=/tmp/fill-10mb bs=1M count=10 2>&1 | tail -1",
  ]);
  log("step1.fill", { exitCode: fillResult.exitCode });

  // ── Step 2: Non-blocking stop ──────────────────────────────────────────
  log("step2.nonblocking_stop.start");
  const stopStart = performance.now();
  await sandbox.stop({ blocking: false });
  const stopIssuedMs = ms(stopStart);
  log("step2.nonblocking_stop.issued", {
    issuedMs: stopIssuedMs,
    statusAfterStop: sandbox.status,
  });

  // ── Step 3: Poll until terminal status ─────────────────────────────────
  log("step3.poll.start");
  const pollStart = performance.now();
  const transitions = [];
  let lastStatus = sandbox.status;
  let terminalStatus = null;
  let terminalMs = null;

  while (ms(pollStart) < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const polled = await Sandbox.get({ name: SANDBOX_NAME });
      const currentStatus = polled.status;
      const elapsed = ms(pollStart);

      if (currentStatus !== lastStatus) {
        transitions.push({
          from: lastStatus,
          to: currentStatus,
          elapsedMs: elapsed,
        });
        lastStatus = currentStatus;
        log("step3.poll.transition", { from: transitions.at(-1).from, to: currentStatus, elapsedMs: elapsed });
      }

      if (["stopped", "failed", "aborted"].includes(currentStatus)) {
        terminalStatus = currentStatus;
        terminalMs = elapsed;
        log("step3.poll.terminal", { status: currentStatus, elapsedMs: elapsed });
        break;
      }
    } catch (err) {
      const elapsed = ms(pollStart);
      log("step3.poll.error", { error: err.message, elapsedMs: elapsed });
      // For persistent sandboxes, 404 during snapshotting would be very concerning
      if (err.message.includes("404")) {
        log("step3.poll.UNEXPECTED_404", {
          message: "Persistent sandbox returned 404 during stop — this should not happen",
          elapsedMs: elapsed,
        });
        terminalStatus = "404-gone";
        terminalMs = elapsed;
        break;
      }
    }
  }

  if (!terminalStatus) {
    log("step3.poll.timeout", { maxPollMs: MAX_POLL_MS, lastStatus });
  }

  log("step3.poll.done", {
    terminalStatus,
    terminalMs,
    transitionCount: transitions.length,
    transitions,
  });

  // ── Step 4: Resume via get() ───────────────────────────────────────────
  log("step4.resume.start");
  const resumeStart = performance.now();
  const resumed = await Sandbox.get({ name: SANDBOX_NAME });
  const resumeMs = ms(resumeStart);
  log("step4.resume.got_handle", {
    resumeMs,
    status: resumed.status,
    sandboxId: resumed.sandboxId,
  });

  // Wait for running if not already
  let resumeStatus = resumed.status;
  const resumeWaitStart = performance.now();
  while (resumeStatus !== "running" && ms(resumeWaitStart) < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const check = await Sandbox.get({ name: SANDBOX_NAME });
      resumeStatus = check.status;
    } catch {
      // Transient — keep polling
    }
  }
  log("step4.resume.status", { status: resumeStatus, waitMs: ms(resumeWaitStart) });

  // Verify marker file survived the stop/resume cycle
  sandbox = resumed; // Update reference for cleanup
  if (resumeStatus === "running") {
    const readResult = await resumed.runCommand("cat", [MARKER_PATH]);
    const stdout = (await readResult.output("stdout")).trim();
    const markerSurvived = stdout === MARKER_CONTENT;
    log("step4.resume.marker_check", {
      markerSurvived,
      expected: MARKER_CONTENT,
      actual: stdout.slice(0, 100),
    });
  } else {
    log("step4.resume.skipped_marker", { reason: `status is ${resumeStatus}, not running` });
  }

  // ── Step 5: Blocking stop (measure total time) ─────────────────────────
  log("step5.blocking_stop.start");
  const blockingStart = performance.now();
  await resumed.stop({ blocking: true });
  const blockingStopMs = ms(blockingStart);
  log("step5.blocking_stop.done", { blockingStopMs });

  // ── Step 6: Delete persistent sandbox ──────────────────────────────────
  log("step6.delete.start");
  try {
    await resumed.delete();
    log("step6.delete.done");
  } catch (err) {
    log("step6.delete.error", { error: err.message });
  }
  sandbox = null; // Prevent double-cleanup

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = {
    sandboxName: SANDBOX_NAME,
    persistent: true,
    nonBlockingStopIssuedMs: stopIssuedMs,
    snapshotTransitions: transitions,
    terminalStatus,
    terminalMs,
    resumeMs,
    resumeStatus,
    blockingStopMs,
    markerContent: MARKER_CONTENT,
  };

  console.log("\n=== FINAL SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

} catch (err) {
  log("FATAL", { error: err.message, stack: err.stack });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.stop().catch(() => {});
      await sandbox.delete().catch(() => {});
      log("cleanup.done");
    } catch {
      log("cleanup.failed");
    }
  }
}
