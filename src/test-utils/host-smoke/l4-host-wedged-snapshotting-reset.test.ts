/**
 * L4-host scenario 3: stop/heartbeat race regression.
 *
 * Older lifecycle code awaited sandbox.stop({ blocking:false }) before
 * parking host metadata in snapshotting. A concurrent heartbeat could then
 * observe meta as running while the SDK already reported stopped, call
 * markSandboxUnavailable(), clear sandboxId, and leave the host wedged at:
 *
 *   meta = { status: "snapshotting", sandboxId: null }
 *
 * The fixed lifecycle parks metadata before awaiting the SDK stop call, so
 * heartbeats are no-ops during the race window and reconciliation can query
 * the named sandbox with resume:false.
 *
 * Asserts:
 *   - stopSandbox() parks snapshotting before the SDK stop resolves.
 *   - touchRunningSandbox() does not clear sandboxId during snapshotting.
 *   - reconcileSnapshottingStatus() repairs snapshotting to stopped.
 *   - resetSandbox() still recovers the stopped state to uninitialized.
 *
 * Run: pnpm test -- src/test-utils/host-smoke/l4-host-wedged-snapshotting-reset.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withHarness } from "@/test-utils/harness";
import {
  reconcileSnapshottingStatus,
  resetSandbox,
  stopSandbox,
  touchRunningSandbox,
} from "@/server/sandbox/lifecycle";

test("L4-host: stop/heartbeat race preserves sandboxId and reconciles snapshotting", async () => {
  await withHarness(async (h) => {
    await h.driveToRunning();

    const handle = h.controller.lastCreated();
    assert.ok(handle, "harness must have created a handle for driveToRunning");
    const sandboxId = handle.sandboxId;

    // Park sandbox.stop() so we can interleave a heartbeat between the
    // SDK accepting the stop and stopSandbox()'s closing mutateMeta.
    let releaseStop: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    handle.stop = async (opts?: { blocking?: boolean }) => {
      handle.stopCalled = true;
      handle.lastStopOptions = opts;
      // Mirror the real SDK: the sandbox is reported stopped *before* the
      // host's mutateMeta lands, so a touchRunningSandbox concurrent with
      // stopSandbox sees status="stopped" via the SDK while the host
      // metadata still says "running".
      handle.setStatus("stopped");
      await stopGate;
    };

    // Force the touch throttle out of the way so our injected heartbeat
    // is allowed through.
    await h.mutateMeta((m) => {
      m.lastAccessedAt = 0;
    });

    // Begin stopSandbox() — promise will park on stopGate.
    const stopPromise = stopSandbox();

    // Allow the lifecycle lock + cleanup steps to reach `await sandbox.stop`.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Heartbeat must be a no-op now that stopSandbox parks metadata
    // before awaiting sandbox.stop().
    await touchRunningSandbox();

    const duringStop = await h.getMeta();
    assert.equal(duringStop.status, "snapshotting");
    assert.equal(
      duringStop.sandboxId,
      sandboxId,
      "heartbeat must not clear sandboxId while stopSandbox is in flight",
    );

    // Release stopSandbox()'s SDK call. The host remains in
    // snapshotting with the sandbox name intact, so reconciliation can
    // query the SDK without resuming it.
    releaseStop!();
    await stopPromise;

    const snapshottingMeta = await h.getMeta();
    assert.equal(snapshottingMeta.status, "snapshotting");
    assert.equal(snapshottingMeta.sandboxId, sandboxId);

    const afterReconcile = await reconcileSnapshottingStatus();
    assert.equal(afterReconcile.status, "stopped", "reconcile must repair snapshotting");
    assert.equal(afterReconcile.sandboxId, sandboxId);

    // resetSandbox() must still recover the stopped state to a clean state.
    const reset = await resetSandbox({
      origin: "https://test.example.com",
      reason: "l4-host.wedge.reset",
    });

    assert.equal(reset.status, "uninitialized", "reset must clear lifecycle state");
    assert.equal(reset.sandboxId, null);
    assert.equal(reset.snapshotId, null);
    assert.equal(reset.lastError, null);
    assert.equal(reset.portUrls, null);

    // Confirm the original sandboxId is no longer remembered anywhere on meta.
    assert.notEqual(reset.sandboxId, sandboxId);
  });
});
