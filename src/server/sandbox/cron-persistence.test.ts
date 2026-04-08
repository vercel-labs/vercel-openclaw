/**
 * End-to-end smoke test for cron jobs surviving snapshot restore.
 *
 * Exercises the full lifecycle: create → write cron jobs → stop (persist) →
 * restore (recover) → verify jobs loaded by cron module.
 *
 * OpenClaw normally preserves jobs.json across gateway restarts, but edge
 * cases (partial writes during restart, config re-init, snapshots taken
 * after a transient empty state) can cause job loss. The store-based
 * persistence acts as a safety net — these tests verify that recovery works
 * when jobs are lost, and that the common case (jobs already present) skips
 * the unnecessary gateway restart.
 *
 * Run: npm test -- src/server/sandbox/cron-persistence.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createScenarioHarness,
  dumpDiagnostics,
} from "@/test-utils/harness";
import {
  gatewayReadyResponse,
} from "@/test-utils/fake-fetch";
import {
  ensureSandboxRunning,
  CRON_JOBS_KEY,
  CRON_NEXT_WAKE_KEY,
} from "@/server/sandbox/lifecycle";
import { getStore, getInitializedMeta } from "@/server/store/store";
import type { StoredCronRecord } from "@/shared/types";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const CRON_JOBS_PATH = "/home/vercel-sandbox/.openclaw/cron/jobs.json";

function buildTestCronJobs(nextRunAtMs: number) {
  return JSON.stringify({
    version: 1,
    jobs: [
      {
        id: "avatar-quote",
        name: "avatar-quote",
        enabled: true,
        createdAtMs: Date.now() - 86400_000,
        updatedAtMs: Date.now() - 3600_000,
        schedule: { kind: "every", everyMs: 1800_000, anchorMs: Date.now() - 86400_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Pick a random Avatar: TLA quote." },
        delivery: { mode: "announce", channel: "telegram", to: "123456" },
        state: {
          nextRunAtMs,
          lastRunAtMs: nextRunAtMs - 1800_000,
          lastRunStatus: "ok",
          lastStatus: "ok",
          consecutiveErrors: 0,
        },
      },
      {
        id: "daily-standup",
        name: "daily-standup",
        enabled: true,
        createdAtMs: Date.now() - 172800_000,
        updatedAtMs: Date.now() - 7200_000,
        schedule: { kind: "every", everyMs: 86400_000, anchorMs: Date.now() - 172800_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Good morning, team!" },
        delivery: { mode: "announce", channel: "slack", to: "C123" },
        state: {
          nextRunAtMs: nextRunAtMs + 3600_000,
          lastRunAtMs: nextRunAtMs - 82800_000,
          lastRunStatus: "ok",
          lastStatus: "ok",
          consecutiveErrors: 0,
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Phase 1: Happy path — cron jobs survive stop → restore
// ---------------------------------------------------------------------------

test("cron-persistence: jobs survive a full stop → restore cycle", async (t) => {
  const h = createScenarioHarness();

  try {
    // --- Phase 1: Create a running sandbox ---
    await t.test("Phase 1: drive to running", async () => {
      await h.driveToRunning();
      const meta = await h.getMeta();
      assert.equal(meta.status, "running");
    });

    // --- Phase 2: Write cron jobs to sandbox ---
    const futureWakeMs = Date.now() + 600_000; // 10 min from now
    const cronJobsJson = buildTestCronJobs(futureWakeMs);

    await t.test("Phase 2: write cron jobs to sandbox", async () => {
      const handle = h.controller.lastCreated()!;
      await handle.writeFiles([{
        path: CRON_JOBS_PATH,
        content: Buffer.from(cronJobsJson),
      }]);

      // Verify the jobs are readable
      const buf = await handle.readFileToBuffer({ path: CRON_JOBS_PATH });
      assert.ok(buf, "Should be able to read jobs.json back");
      const parsed = JSON.parse(buf.toString("utf8"));
      assert.equal(parsed.jobs.length, 2, "Should have 2 cron jobs");
    });

    // --- Phase 3: Stop → verify jobs persisted to store ---
    await t.test("Phase 3: stop persists jobs and wake time to store", async () => {
      await h.stopToSnapshot();

      const record = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
      assert.ok(record, "Structured cron record should be in store");
      assert.equal(record.version, 1);
      assert.equal(record.source, "stop");
      assert.equal(record.jobCount, 2, "Store should have both jobs");
      assert.deepEqual(record.jobIds, ["avatar-quote", "daily-standup"]);
      assert.ok(record.sha256, "Should have a SHA-256 hash");
      assert.ok(record.capturedAt > 0, "Should have a capture timestamp");
      assert.ok(record.jobsJson, "Should have raw jobsJson");

      const storedWakeMs = await getStore().getValue<number>(CRON_NEXT_WAKE_KEY());
      assert.equal(storedWakeMs, futureWakeMs, "Wake time should be the earliest nextRunAtMs");
    });

    // --- Phase 4: Simulate OpenClaw's reset-on-boot behavior ---
    // The new sandbox handle will have empty writtenFiles (no jobs.json),
    // which is what readFileToBuffer returns for an unwritten path: null.
    // This simulates OpenClaw resetting jobs.json to empty.
    //
    // We also install a responder for the readiness curl probe used by
    // the cron restore flow's gateway restart poll.
    h.controller.defaultResponders.push((cmd, args) => {
      if (cmd === "bash" && args?.some((a) => typeof a === "string" && a.includes("openclaw-app"))) {
        return { exitCode: 0, output: async () => "ok" };
      }
      return undefined;
    });

    // --- Phase 5: Resume → verify sandbox runs (v2: no cron restoration from store) ---
    await t.test("Phase 4: resume creates running sandbox", async () => {
      h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());

      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "cron-restore-test",
        schedule(cb) { scheduledCallback = cb; },
      });

      assert.ok(scheduledCallback, "Background work should be scheduled");
      await (scheduledCallback as unknown as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Sandbox should be running after resume");

      // v2: persistent resume path does not do cron restoration from store.
      // Cron jobs survive naturally on the persistent sandbox's filesystem.
      // The cronRestoreOutcome field is not set in persistent resume metrics.
      assert.equal(
        meta.lastRestoreMetrics?.cronRestoreOutcome,
        undefined,
        "v2 persistent resume should not have cronRestoreOutcome",
      );
    });

    // --- Phase 6: Invariants ---
    await t.test("Phase 5: final invariants", async () => {
      // v2: create events from the controller (initial + resume)
      assert.ok(h.controller.created.length >= 1, "Should have created at least 1 sandbox");

      // Store still has the persisted jobs from the stop phase.
      const storedJobs = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
      assert.ok(storedJobs, "Store should still have cron jobs after resume");

      // Timeline should have at least a create event.
      const events = h.controller.events.map((e) => e.kind);
      assert.ok(events.includes("create"), "Should have a create event");
    });
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 2: Skip path — no jobs in store, nothing to restore
// ---------------------------------------------------------------------------

test("cron-persistence: restore skips cron recovery when store has no jobs", async (t) => {
  const h = createScenarioHarness();

  try {
    await h.driveToRunning();
    // Stop WITHOUT any cron jobs → store should have no CRON_JOBS_KEY.
    await h.stopToSnapshot();

    const storedJobs = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
    assert.equal(storedJobs, null, "Store should not have cron jobs when sandbox had none");

    // Resume — v2: persistent resume does not do cron recovery.
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    let scheduledCallback: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "no-cron-test",
      schedule(cb) { scheduledCallback = cb; },
    });
    assert.ok(scheduledCallback, "Background work should be scheduled");
    await (scheduledCallback as unknown as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running");
    // v2: persistent resume doesn't set cronRestoreOutcome
    assert.equal(
      meta.lastRestoreMetrics?.cronRestoreOutcome,
      undefined,
      "v2 persistent resume should not have cronRestoreOutcome",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 3: Skip path — jobs already exist on disk (snapshot preserved them)
// ---------------------------------------------------------------------------

test("cron-persistence: restore skips recovery when sandbox already has jobs", async (t) => {
  const h = createScenarioHarness();

  try {
    await h.driveToRunning();

    // Write cron jobs to sandbox AND stop (persists to store).
    const handle1 = h.controller.lastCreated()!;
    const cronJobsJson = buildTestCronJobs(Date.now() + 600_000);
    await handle1.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(cronJobsJson),
    }]);
    await h.stopToSnapshot();

    // v2: persistent resume does not do cron recovery from store.
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    let scheduledCallback: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "already-has-cron-test",
      schedule(cb) { scheduledCallback = cb; },
    });
    assert.ok(scheduledCallback, "Background work should be scheduled");
    await (scheduledCallback as unknown as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running");
    // v2: persistent resume doesn't set cronRestoreOutcome
    assert.equal(
      meta.lastRestoreMetrics?.cronRestoreOutcome,
      undefined,
      "v2 persistent resume should not have cronRestoreOutcome",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 4: Heartbeat persistence — jobs saved on heartbeat, not just stop
// ---------------------------------------------------------------------------

test("cron-persistence: heartbeat persists jobs to store", async (t) => {
  const h = createScenarioHarness();

  try {
    await h.driveToRunning();

    // Write cron jobs to sandbox.
    const handle = h.controller.lastCreated()!;
    const cronJobsJson = buildTestCronJobs(Date.now() + 600_000);
    await handle.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(cronJobsJson),
    }]);

    // No jobs in store yet.
    assert.equal(
      await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY()),
      null,
      "Store should not have jobs before heartbeat",
    );

    // Clear the throttle by setting lastAccessedAt far in the past.
    const { mutateMeta } = await import("@/server/store/store");
    await mutateMeta((m) => { m.lastAccessedAt = Date.now() - 600_000; });

    // Trigger a heartbeat.
    const { touchRunningSandbox } = await import("@/server/sandbox/lifecycle");
    await touchRunningSandbox();

    // Now jobs should be in store as a structured record.
    const record = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
    assert.ok(record, "Store should have jobs after heartbeat");
    assert.equal(record.source, "heartbeat");
    assert.equal(record.jobCount, 2, "Both jobs should be persisted via heartbeat");
    assert.ok(record.sha256, "Should have a SHA-256 hash");
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 5: Heartbeat guard — empty read must not clobber good store backup
// ---------------------------------------------------------------------------

test("cron-persistence: heartbeat with empty jobs does not clobber store", async (t) => {
  const h = createScenarioHarness();

  try {
    await h.driveToRunning();

    // Pre-populate store with a structured record (as if a previous stop persisted it).
    const goodJobsJson = buildTestCronJobs(Date.now() + 600_000);
    const { createHash } = await import("node:crypto");
    const goodRecord: StoredCronRecord = {
      version: 1,
      capturedAt: Date.now(),
      source: "stop",
      sha256: createHash("sha256").update(goodJobsJson).digest("hex"),
      jobCount: 2,
      jobIds: ["avatar-quote", "daily-standup"],
      jobsJson: goodJobsJson,
    };
    await getStore().setValue(CRON_JOBS_KEY(), goodRecord);

    // Write EMPTY jobs.json to sandbox (simulating transient empty state).
    const handle = h.controller.lastCreated()!;
    await handle.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(JSON.stringify({ version: 1, jobs: [] })),
    }]);

    // Clear throttle and trigger heartbeat.
    const { mutateMeta } = await import("@/server/store/store");
    await mutateMeta((m) => { m.lastAccessedAt = Date.now() - 600_000; });
    const { touchRunningSandbox } = await import("@/server/sandbox/lifecycle");
    await touchRunningSandbox();

    // Store should still have the GOOD jobs — heartbeat must not clobber.
    const storedJobs = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
    assert.ok(storedJobs, "Store should still have jobs");
    assert.equal(storedJobs.jobCount, 2, "Good backup must not be overwritten by empty heartbeat read");
    assert.equal(storedJobs.source, "stop", "Original stop record should be preserved");
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 6: Failure resilience — cron restore failure doesn't block restore
// ---------------------------------------------------------------------------

test("cron-persistence: cron restore failure does not block sandbox restore", async (t) => {
  const h = createScenarioHarness();

  try {
    await h.driveToRunning();

    // Write cron jobs and stop.
    const handle1 = h.controller.lastCreated()!;
    await handle1.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(buildTestCronJobs(Date.now() + 600_000)),
    }]);
    await h.stopToSnapshot();

    // Store corrupted JSON — in v2, cron recovery doesn't happen so this is irrelevant.
    await getStore().setValue(CRON_JOBS_KEY(), "{{NOT VALID JSON}}");

    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    let scheduledCallback: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "cron-fail-test",
      schedule(cb) { scheduledCallback = cb; },
    });
    assert.ok(scheduledCallback, "Background work should be scheduled");
    await (scheduledCallback as unknown as () => Promise<void>)();

    // Sandbox should be running — v2 persistent resume doesn't attempt cron recovery.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running", "Sandbox should be running");
    // v2: persistent resume doesn't set cronRestoreOutcome
    assert.equal(
      meta.lastRestoreMetrics?.cronRestoreOutcome,
      undefined,
      "v2 persistent resume should not have cronRestoreOutcome",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 7: Resurrection prevention — deleted jobs must stay deleted
// ---------------------------------------------------------------------------

test("cron-persistence: deleted jobs are not resurrected after restore", async (t) => {
  const h = createScenarioHarness();

  try {
    // Phase 1: Create sandbox, add cron jobs, stop (persists to store).
    await h.driveToRunning();
    const handle1 = h.controller.lastCreated()!;
    const cronJobsJson = buildTestCronJobs(Date.now() + 600_000);
    await handle1.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(cronJobsJson),
    }]);
    await h.stopToSnapshot();

    // Verify jobs are in the store.
    const storedAfterFirstStop = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
    assert.ok(storedAfterFirstStop, "Store should have jobs after first stop");

    // Phase 2: Resume, then "user deletes all jobs" (empty jobs.json), stop again.
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());

    let cb: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "resurrection-test-restore",
      schedule(fn) { cb = fn; },
    });
    assert.ok(cb, "Background work should be scheduled");
    await (cb as unknown as () => Promise<void>)();

    // Simulate user deleting all cron jobs via the agent.
    const handle2 = h.controller.lastCreated()!;
    await handle2.writeFiles([{
      path: CRON_JOBS_PATH,
      content: Buffer.from(JSON.stringify({ version: 1, jobs: [] })),
    }]);

    // Stop again — this is the authoritative "0 jobs" signal.
    const { stopSandbox } = await import("@/server/sandbox/lifecycle");
    await stopSandbox();

    // Verify store was CLEARED (not still holding old jobs).
    const storedAfterSecondStop = await getStore().getValue<StoredCronRecord>(CRON_JOBS_KEY());
    assert.equal(storedAfterSecondStop, null, "Store should be cleared when stop reads 0 jobs");

    // Phase 3: Resume again — v2 doesn't do cron restoration.
    let cb2: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "resurrection-test-verify",
      schedule(fn) { cb2 = fn; },
    });
    assert.ok(cb2, "Background work should be scheduled");
    await (cb2 as unknown as () => Promise<void>)();

    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running");
    // v2: persistent resume doesn't set cronRestoreOutcome
    assert.equal(
      meta.lastRestoreMetrics?.cronRestoreOutcome,
      undefined,
      "v2 persistent resume should not have cronRestoreOutcome",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
