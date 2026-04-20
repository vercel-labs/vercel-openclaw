import assert from "node:assert/strict";
import test from "node:test";

import {
  _resetReconcileStaleRunningDebounceForTesting,
  reconcileStaleRunningStatus,
} from "@/server/sandbox/lifecycle";
import { _setSandboxControllerForTesting } from "@/server/sandbox/controller";
import { _resetLogBuffer, getServerLogs } from "@/server/log";
import { _resetStoreForTesting, mutateMeta } from "@/server/store/store";
import { FakeSandboxController } from "@/test-utils/fake-sandbox-controller";

const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  VERCEL: undefined,
  REDIS_URL: undefined,
  KV_URL: undefined,
  AI_GATEWAY_API_KEY: "test-key",
};

async function withEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(TEST_ENV)) {
    originals[key] = process.env[key];
    if (TEST_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = TEST_ENV[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
    _resetStoreForTesting();
    _resetReconcileStaleRunningDebounceForTesting();
    _resetLogBuffer();
    _setSandboxControllerForTesting(null);
  }
}

test("reconcile: concurrent callers share one inner run (in-flight coalesce)", async () => {
  await withEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    // Create a running handle then seed meta to "running".
    const handle = await controller.create({
      name: "oc-test-reconcile",
      persistent: true,
      ports: [3000],
    });
    // Force the SDK-side status to "stopped" so reconcile writes a
    // new meta status.
    (handle as unknown as { setStatus: (s: string) => void }).setStatus("stopped");

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
    });

    let innerGetCount = 0;
    const originalGet = controller.get.bind(controller);
    controller.get = (async (input: { sandboxId: string }) => {
      innerGetCount += 1;
      return originalGet(input);
    }) as typeof controller.get;

    // Fire 5 concurrent reconciles.
    const results = await Promise.all([
      reconcileStaleRunningStatus(),
      reconcileStaleRunningStatus(),
      reconcileStaleRunningStatus(),
      reconcileStaleRunningStatus(),
      reconcileStaleRunningStatus(),
    ]);

    // All callers should see the reconciled "stopped" state.
    for (const meta of results) {
      assert.equal(meta.status, "stopped");
    }
    assert.equal(
      innerGetCount,
      1,
      "exactly one SDK get() call across concurrent callers",
    );

    const joinedLogs = getServerLogs().filter(
      (entry) =>
        entry.message ===
        "sandbox.reconcile_stale_running_status_joined_in_flight",
    );
    assert.ok(joinedLogs.length >= 1, "at least one caller joined in-flight");
  });
});

test("reconcile: completed result is reused within debounce window", async () => {
  await withEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const handle = await controller.create({
      name: "oc-test-reconcile-cached",
      persistent: true,
      ports: [3000],
    });
    (handle as unknown as { setStatus: (s: string) => void }).setStatus("stopped");

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
    });

    let innerGetCount = 0;
    const originalGet = controller.get.bind(controller);
    controller.get = (async (input: { sandboxId: string }) => {
      innerGetCount += 1;
      return originalGet(input);
    }) as typeof controller.get;

    await reconcileStaleRunningStatus();
    const afterFirst = innerGetCount;
    assert.equal(afterFirst, 1);

    // Second call inside the debounce window must NOT hit SDK.get again.
    const cached = await reconcileStaleRunningStatus();
    assert.equal(innerGetCount, afterFirst, "debounce window reuses cached result");
    assert.equal(cached.status, "stopped");

    const debouncedLogs = getServerLogs().filter(
      (entry) =>
        entry.message === "sandbox.reconcile_stale_running_status_debounced",
    );
    assert.equal(debouncedLogs.length, 1);
  });
});

test("reconcile: reset clears cache so next call hits SDK again", async () => {
  await withEnv(async () => {
    const controller = new FakeSandboxController();
    _setSandboxControllerForTesting(controller);

    const handle = await controller.create({
      name: "oc-test-reconcile-reset",
      persistent: true,
      ports: [3000],
    });
    (handle as unknown as { setStatus: (s: string) => void }).setStatus("stopped");

    await mutateMeta((meta) => {
      meta.status = "running";
      meta.sandboxId = handle.sandboxId;
    });

    let innerGetCount = 0;
    const originalGet = controller.get.bind(controller);
    controller.get = (async (input: { sandboxId: string }) => {
      innerGetCount += 1;
      return originalGet(input);
    }) as typeof controller.get;

    await reconcileStaleRunningStatus();
    assert.equal(innerGetCount, 1);

    // Reset the debounce; but reconciled meta is stopped now, so next
    // reconcile short-circuits before SDK.get anyway. Force meta back
    // to running to exercise the fresh-reconcile path.
    _resetReconcileStaleRunningDebounceForTesting();
    await mutateMeta((meta) => {
      meta.status = "running";
    });

    await reconcileStaleRunningStatus();
    assert.equal(innerGetCount, 2, "post-reset reconcile hits SDK again");
  });
});
