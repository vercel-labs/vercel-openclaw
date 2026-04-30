import assert from "node:assert/strict";
import test from "node:test";

import {
  FAST_POLL_INTERVAL_MS,
  SANDBOX_TRANSITIONAL_STATES,
  SLOW_POLL_INTERVAL_MS,
  SNAPSHOTTING_WEDGE_THRESHOLD_MS,
  computePollIntervalMs,
  isSnapshottingWedged,
  isTransitionalStatus,
} from "./use-sandbox-status";

test("transitional state set covers every documented mid-flight lifecycle", () => {
  // These are the states that the host reconciles automatically and that the
  // UI must fast-poll to keep the badge from going stale.
  for (const state of [
    "snapshotting",
    "creating",
    "setup",
    "restoring",
    "booting",
  ]) {
    assert.ok(
      SANDBOX_TRANSITIONAL_STATES.has(state),
      `expected '${state}' in transitional set`,
    );
    assert.equal(isTransitionalStatus(state), true);
  }

  // Settled states should NOT be in the transitional set.
  for (const state of ["running", "stopped", "uninitialized", "error"]) {
    assert.ok(
      !SANDBOX_TRANSITIONAL_STATES.has(state),
      `did not expect '${state}' in transitional set`,
    );
    assert.equal(isTransitionalStatus(state), false);
  }
});

test("computePollIntervalMs picks 3s for transitional, 30s for settled", () => {
  assert.equal(computePollIntervalMs("snapshotting"), FAST_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("creating"), FAST_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("restoring"), FAST_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("booting"), FAST_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("setup"), FAST_POLL_INTERVAL_MS);

  assert.equal(computePollIntervalMs("running"), SLOW_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("stopped"), SLOW_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("uninitialized"), SLOW_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs("error"), SLOW_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs(null), SLOW_POLL_INTERVAL_MS);
  assert.equal(computePollIntervalMs(undefined), SLOW_POLL_INTERVAL_MS);
});

test("FAST_POLL_INTERVAL_MS / SLOW_POLL_INTERVAL_MS match the spec", () => {
  // The bug report specifically asks for 3s during transitional and 30s
  // otherwise; lock those numbers down so future tweaks come with a test.
  assert.equal(FAST_POLL_INTERVAL_MS, 3_000);
  assert.equal(SLOW_POLL_INTERVAL_MS, 30_000);
});

test("isSnapshottingWedged only fires after threshold while still snapshotting", () => {
  const firstSeen = 1_000_000;
  const justBefore = firstSeen + SNAPSHOTTING_WEDGE_THRESHOLD_MS - 1;
  const exactlyAt = firstSeen + SNAPSHOTTING_WEDGE_THRESHOLD_MS;
  const wellAfter = firstSeen + SNAPSHOTTING_WEDGE_THRESHOLD_MS + 60_000;

  // Not snapshotting: never wedged.
  assert.equal(isSnapshottingWedged("running", firstSeen, wellAfter), false);
  assert.equal(isSnapshottingWedged("stopped", firstSeen, wellAfter), false);

  // Snapshotting, but not yet past threshold.
  assert.equal(
    isSnapshottingWedged("snapshotting", firstSeen, justBefore),
    false,
  );

  // Snapshotting, exactly at and past threshold.
  assert.equal(
    isSnapshottingWedged("snapshotting", firstSeen, exactlyAt),
    true,
  );
  assert.equal(
    isSnapshottingWedged("snapshotting", firstSeen, wellAfter),
    true,
  );

  // Snapshotting, but we never recorded a first-seen yet.
  assert.equal(isSnapshottingWedged("snapshotting", null, wellAfter), false);
});

test("SNAPSHOTTING_WEDGE_THRESHOLD_MS is beyond the server stale guardrail", () => {
  assert.equal(SNAPSHOTTING_WEDGE_THRESHOLD_MS, 6 * 60 * 1000);
});
