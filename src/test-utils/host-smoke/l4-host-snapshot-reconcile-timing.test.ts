/**
 * L4-host scenario: snapshot reconcile timing regression.
 *
 * Background:
 *   `reconcileSnapshottingStatus()` flips meta.status from "snapshotting" to
 *   "stopped" only on the next /api/status read AFTER the SDK confirms the
 *   auto-snapshot finished. If reconcile work becomes slow or busy-loops, the
 *   UI can watch "snapshotting" forever even though the host could recover
 *   immediately. This file guards the host-side reconcile latency once the
 *   SDK reports the sandbox stopped.
 *
 * Run: npm test src/test-utils/host-smoke/l4-host-snapshot-reconcile-timing.test.ts
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  reconcileSnapshottingStatus,
  stopSandbox,
} from "@/server/sandbox/lifecycle";
import type { SingleStatus } from "@/shared/types";

test("L4-host snapshot reconcile: fast happy path is bounded under fakes", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const handle = h.controller.lastCreated();
    assert.ok(handle, "harness must have created a handle for driveToRunning");
    const sandboxId = handle.sandboxId;

    // Default FakeSandboxHandle.stop() flips _status to "stopped" immediately,
    // so the next reconcile call should see SDK status="stopped".
    const afterStop = await stopSandbox();
    assert.equal(
      afterStop.status,
      "snapshotting",
      "stopSandbox parks meta at snapshotting before reconcile",
    );

    const t0 = performance.now();
    const reconciled = await reconcileSnapshottingStatus();
    const elapsed = performance.now() - t0;

    assert.equal(
      reconciled.status,
      "stopped",
      "reconcile should flip status to stopped once SDK reports stopped",
    );
    assert.equal(
      reconciled.sandboxId,
      sandboxId,
      "reconcile must retain sandboxId so the sandbox can be resumed",
    );
    assert.ok(
      elapsed < 100,
      `reconcile should be near-instant under fakes (took ${elapsed.toFixed(2)}ms)`,
    );
  });
});

test("L4-host snapshot reconcile: bounded-delay path resolves within poll cap without flips", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const handle = h.controller.lastCreated();
    assert.ok(handle, "harness must have created a handle for driveToRunning");
    const sandboxId = handle.sandboxId;

    // Override stop() so the SDK keeps reporting "snapshotting" for the first
    // 2 status reads after stop, then reports "stopped" on the 3rd. Reconcile
    // must continue to converge without flipping back to "running" or
    // entering an infinite loop.
    let getCallsAfterStop = 0;
    const originalStop = handle.stop.bind(handle);
    handle.stop = async (opts?: { blocking?: boolean }) => {
      handle.stopCalled = true;
      handle.lastStopOptions = opts;
      // Default fake flips to "stopped" immediately; override that so the
      // SDK appears to still be finishing the auto-snapshot.
      handle.setStatus("snapshotting");
    };
    void originalStop; // keep reference to silence unused warnings

    // Wrap the underlying status getter via setStatus polling: each time the
    // host calls `controller.get()` (which returns the same handle) and reads
    // `.status`, advance the counter. We approximate that by overriding the
    // controller.get behavior through the existing handle's status.
    // Simplest portable approach: pre-stage status flips around each
    // reconcile call below.

    const afterStop = await stopSandbox();
    assert.equal(afterStop.status, "snapshotting");

    // Track the meta.status progression to ensure we go
    // running -> snapshotting -> stopped exactly, without flips.
    const progression: string[] = ["running", afterStop.status];

    const MAX_POLLS = 30;
    let polls = 0;
    let finalStatus: SingleStatus = afterStop.status;
    while (polls < MAX_POLLS) {
      polls += 1;
      getCallsAfterStop += 1;
      // Simulate the SDK finishing on the 3rd poll.
      if (getCallsAfterStop >= 3) {
        handle.setStatus("stopped");
      }

      const reconciled = await reconcileSnapshottingStatus();
      if (
        progression[progression.length - 1] !== reconciled.status
      ) {
        progression.push(reconciled.status);
      }
      finalStatus = reconciled.status;
      if (reconciled.status === "stopped") {
        assert.equal(
          reconciled.sandboxId,
          sandboxId,
          "reconcile must retain sandboxId once it converges",
        );
        break;
      }
    }

    assert.equal(
      finalStatus,
      "stopped",
      `reconcile must converge to stopped within ${MAX_POLLS} polls`,
    );
    assert.ok(
      polls <= MAX_POLLS,
      `reconcile exceeded poll cap (${polls} > ${MAX_POLLS})`,
    );
    assert.deepEqual(
      progression,
      ["running", "snapshotting", "stopped"],
      `meta.status progression must be running -> snapshotting -> stopped without flips, saw ${JSON.stringify(progression)}`,
    );
  });
});
