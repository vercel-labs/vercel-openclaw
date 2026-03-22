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

      const storedJobs = await getStore().getValue<string>(CRON_JOBS_KEY);
      assert.ok(storedJobs, "Full cron jobs JSON should be in store");
      const parsed = JSON.parse(storedJobs);
      assert.equal(parsed.jobs.length, 2, "Store should have both jobs");
      assert.equal(parsed.jobs[0].id, "avatar-quote");
      assert.equal(parsed.jobs[1].id, "daily-standup");

      const storedWakeMs = await getStore().getValue<number>(CRON_NEXT_WAKE_KEY);
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

    // --- Phase 5: Restore → verify jobs recovered ---
    await t.test("Phase 4: restore recovers cron jobs from store", async () => {
      h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());

      let scheduledCallback: (() => Promise<void> | void) | null = null;
      await ensureSandboxRunning({
        origin: "https://test.example.com",
        reason: "cron-restore-test",
        schedule(cb) { scheduledCallback = cb; },
      });

      assert.ok(scheduledCallback, "Background restore work should be scheduled");
      assert.ok(scheduledCallback, "Background work should be scheduled");
    await (scheduledCallback as unknown as () => Promise<void>)();

      const meta = await getInitializedMeta();
      assert.equal(meta.status, "running", "Sandbox should be running after restore");

      // Verify cron jobs were written to the new sandbox
      const newHandle = h.controller.lastCreated()!;
      const cronWrite = newHandle.writtenFiles.find(
        (f) => f.path === CRON_JOBS_PATH,
      );
      assert.ok(cronWrite, "Cron jobs should be written to the restored sandbox");

      const restoredJobs = JSON.parse(cronWrite.content.toString("utf8"));
      assert.equal(restoredJobs.jobs.length, 2, "Both jobs should be restored");
      assert.equal(restoredJobs.jobs[0].id, "avatar-quote");
      assert.equal(restoredJobs.jobs[1].id, "daily-standup");

      // Verify the gateway restart script was run (so cron module reloads)
      const restartCmd = newHandle.commands.find(
        (c) => c.cmd === "bash" && c.args?.some((a: string) => a.includes("restart-gateway")),
      );
      assert.ok(restartCmd, "Gateway should be restarted to load restored jobs");

      // Verify restore metrics
      assert.equal(
        meta.lastRestoreMetrics?.cronJobsRestored,
        true,
        "Metrics should record cronJobsRestored=true",
      );
    });

    // --- Phase 6: Invariants ---
    await t.test("Phase 5: final invariants", async () => {
      // Two sandboxes created: first for initial run, second for restore.
      assert.equal(h.controller.created.length, 2, "Should have created 2 sandboxes");

      // Store still has the persisted jobs (not cleared by restore).
      const storedJobs = await getStore().getValue<string>(CRON_JOBS_KEY);
      assert.ok(storedJobs, "Store should still have cron jobs after restore");

      // Timeline should show create → snapshot → restore sequence.
      const events = h.controller.events.map((e) => e.kind);
      assert.ok(events.includes("create"), "Should have a create event");
      assert.ok(events.includes("snapshot"), "Should have a snapshot event");
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

    const storedJobs = await getStore().getValue<string>(CRON_JOBS_KEY);
    assert.equal(storedJobs, null, "Store should not have cron jobs when sandbox had none");

    // Restore — should skip cron recovery entirely.
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
    assert.equal(meta.lastRestoreMetrics?.cronJobsRestored, false, "Should not restore cron when store is empty");

    // No cron jobs should have been written to the sandbox.
    const newHandle = h.controller.lastCreated()!;
    const cronWrite = newHandle.writtenFiles.find(
      (f) => f.path === CRON_JOBS_PATH,
    );
    assert.ok(!cronWrite, "Should not write cron jobs when store is empty");

    // No gateway restart needed.
    const restartCmd = newHandle.commands.find(
      (c) => c.cmd === "bash" && c.args?.some((a: string) => a.includes("restart-gateway")),
    );
    assert.ok(!restartCmd, "Should not restart gateway when no cron jobs to restore");
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

    // Simulate a restore where OpenClaw DIDN'T wipe jobs (snapshot preserves them).
    // Pre-seed the new handle's writtenFiles so readFileToBuffer returns the jobs.
    h.controller.defaultResponders.push((cmd, args) => {
      if (cmd === "bash" && args?.some((a) => typeof a === "string" && a.includes("openclaw-app"))) {
        return { exitCode: 0, output: async () => "ok" };
      }
      return undefined;
    });

    // The FakeSandboxController creates a new handle for the restore.
    // We need the new handle to have jobs.json already — this simulates
    // the snapshot's filesystem preserving the file.
    // Since writeFiles is how the fake tracks files, we hook into create
    // to pre-populate.
    const origCreate = h.controller.create.bind(h.controller);
    h.controller.create = async (params) => {
      const newHandle = await origCreate(params);
      // Simulate: snapshot filesystem has the jobs (OpenClaw hasn't wiped yet)
      await newHandle.writeFiles([{
        path: CRON_JOBS_PATH,
        content: Buffer.from(cronJobsJson),
      }]);
      return newHandle;
    };

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
    assert.equal(
      meta.lastRestoreMetrics?.cronJobsRestored,
      false,
      "Should not restore cron when sandbox already has jobs",
    );

    // Gateway should NOT have been restarted — jobs were already there.
    const newHandle = h.controller.lastCreated()!;
    const restartCmd = newHandle.commands.find(
      (c) => c.cmd === "bash" && c.args?.some((a: string) => a.includes("restart-gateway")),
    );
    assert.ok(!restartCmd, "Should not restart gateway when jobs already exist in sandbox");
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
      await getStore().getValue<string>(CRON_JOBS_KEY),
      null,
      "Store should not have jobs before heartbeat",
    );

    // Clear the throttle by setting lastAccessedAt far in the past.
    const { mutateMeta } = await import("@/server/store/store");
    await mutateMeta((m) => { m.lastAccessedAt = Date.now() - 600_000; });

    // Trigger a heartbeat.
    const { touchRunningSandbox } = await import("@/server/sandbox/lifecycle");
    await touchRunningSandbox();

    // Now jobs should be in store.
    const storedJobs = await getStore().getValue<string>(CRON_JOBS_KEY);
    assert.ok(storedJobs, "Store should have jobs after heartbeat");
    const parsed = JSON.parse(storedJobs);
    assert.equal(parsed.jobs.length, 2, "Both jobs should be persisted via heartbeat");
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});

// ---------------------------------------------------------------------------
// Phase 5: Failure resilience — cron restore failure doesn't block restore
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

    // Store corrupted JSON so the cron restore path hits a parse error.
    await getStore().setValue(CRON_JOBS_KEY, "{{NOT VALID JSON}}");

    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    let scheduledCallback: (() => Promise<void> | void) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "cron-fail-test",
      schedule(cb) { scheduledCallback = cb; },
    });
    assert.ok(scheduledCallback, "Background work should be scheduled");
    await (scheduledCallback as unknown as () => Promise<void>)();

    // Sandbox should still be running despite cron restore failure.
    const meta = await getInitializedMeta();
    assert.equal(meta.status, "running", "Sandbox should be running despite cron failure");
    assert.equal(
      meta.lastRestoreMetrics?.cronJobsRestored,
      false,
      "Metrics should show cron was not restored",
    );
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
