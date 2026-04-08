/**
 * Tests for SandboxController — the injectable interface over @vercel/sandbox.
 *
 * Validates the _setSandboxControllerForTesting swap mechanism and
 * verifies that FakeSandboxHandle conforms to the SandboxHandle interface shape.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getSandboxController,
  _setSandboxControllerForTesting,
  type SandboxHandle,
  type CommandResult,
  type SnapshotResult,
  type CreateParams,
} from "@/server/sandbox/controller";
import {
  FakeSandboxController,
  FakeSandboxHandle,
  type SandboxEvent,
} from "@/test-utils/fake-sandbox-controller";

test("controller: getSandboxController throws when no test controller is set", () => {
  // In NODE_ENV=test, getSandboxController() requires _setSandboxControllerForTesting() first
  _setSandboxControllerForTesting(null);
  assert.throws(
    () => getSandboxController(),
    { message: /not initialized for testing/ },
    "should throw when no test controller is set",
  );
});

test("controller: _setSandboxControllerForTesting swaps in fake controller", () => {
  const fake = new FakeSandboxController();
  _setSandboxControllerForTesting(fake);
  assert.strictEqual(getSandboxController(), fake);
  _setSandboxControllerForTesting(null);
});

test("controller: _setSandboxControllerForTesting(null) clears active controller", () => {
  const fake = new FakeSandboxController();
  _setSandboxControllerForTesting(fake);
  _setSandboxControllerForTesting(null);
  // After clearing, getSandboxController should throw (no active controller in test mode)
  assert.throws(
    () => getSandboxController(),
    { message: /not initialized for testing/ },
  );
});

test("controller: FakeSandboxHandle conforms to SandboxHandle interface", async () => {
  const events: SandboxEvent[] = [];
  const handle: SandboxHandle = new FakeSandboxHandle("sbx-test", events);

  // sandboxId
  assert.equal(handle.sandboxId, "sbx-test");

  // runCommand
  const result = await handle.runCommand("echo", ["hello"]);
  assert.equal(typeof result.exitCode, "number");
  assert.equal(typeof (await result.output()), "string");

  // writeFiles
  await handle.writeFiles([{ path: "test.txt", content: Buffer.from("hello") }]);

  // domain
  const domain = handle.domain(3000);
  assert.equal(typeof domain, "string");
  assert.ok(domain.includes("sbx-test"), "domain should contain sandbox id");

  // snapshot
  const snap = await handle.snapshot();
  assert.equal(typeof snap.snapshotId, "string");
  assert.ok(snap.snapshotId.includes("sbx-test"));

  // extendTimeout
  await handle.extendTimeout(60_000);

  // updateNetworkPolicy
  const policy = await handle.updateNetworkPolicy("allow-all");
  assert.equal(policy, "allow-all");
});

test("controller: FakeSandboxController.create tracks events", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.create({ ports: [3000] });

  assert.ok(handle.sandboxId.startsWith("sbx-fake-"));
  assert.equal(controller.created.length, 1);
  assert.equal(controller.events.length, 1);
  assert.equal(controller.events[0]!.kind, "create");
});

test("controller: FakeSandboxController.create with snapshot source records restore event", async () => {
  const controller = new FakeSandboxController();
  const params: CreateParams = {
    ports: [3000],
    source: { type: "snapshot", snapshotId: "snap-123" },
  };
  await controller.create(params);

  assert.equal(controller.events[0]!.kind, "restore");
  assert.deepEqual(controller.events[0]!.detail, { snapshotId: "snap-123" });
});

test("controller: FakeSandboxController.get returns tracked handle", async () => {
  const controller = new FakeSandboxController();
  const created = await controller.create({});
  const retrieved = await controller.get({ sandboxId: created.sandboxId });

  assert.strictEqual(retrieved, created);
  assert.deepEqual(controller.retrieved, [created.sandboxId]);
});

test("controller: FakeSandboxController.get creates new handle for unknown id", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.get({ sandboxId: "sbx-unknown" });

  assert.equal(handle.sandboxId, "sbx-unknown");
  assert.deepEqual(controller.retrieved, ["sbx-unknown"]);
});

test("controller: FakeSandboxHandle.responders override default command result", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-resp", events);

  handle.responders.push((cmd, _args) => {
    if (cmd === "node") {
      return { exitCode: 42, output: async () => "custom output" };
    }
    return undefined;
  });

  const nodeResult = await handle.runCommand("node", ["-e", "1"]);
  assert.equal(nodeResult.exitCode, 42);
  assert.equal(await nodeResult.output(), "custom output");

  // Non-matching commands fall through to default
  const echoResult = await handle.runCommand("echo", ["hi"]);
  assert.equal(echoResult.exitCode, 0);
});

test("controller: FakeSandboxHandle tracks all operations in event log", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-log", events);

  await handle.runCommand("ls", ["-la"]);
  await handle.writeFiles([{ path: "a.txt", content: Buffer.from("a") }]);
  await handle.extendTimeout(5000);
  await handle.updateNetworkPolicy({ allow: ["example.com"] });
  await handle.snapshot();

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "command",
    "write_files",
    "extend_timeout",
    "update_network_policy",
    "snapshot",
  ]);
});

test("controller: FakeSandboxController.eventsOfKind filters correctly", async () => {
  const controller = new FakeSandboxController();
  const h1 = await controller.create({});
  await h1.runCommand("echo", []);
  await h1.snapshot();
  const h2 = await controller.create({});
  await h2.runCommand("ls", []);

  assert.equal(controller.eventsOfKind("create").length, 2);
  assert.equal(controller.eventsOfKind("command").length, 2);
  assert.equal(controller.eventsOfKind("snapshot").length, 1);
});

test("controller: FakeSandboxHandle preserves create-time timeout", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-timeout", events, 300_000);

  assert.equal(handle.timeout, 300_000, "initial timeout should match create param");
});

test("controller: FakeSandboxHandle.extendTimeout is additive", async () => {
  const events: SandboxEvent[] = [];
  const handle = new FakeSandboxHandle("sbx-ext", events, 300_000);

  await handle.extendTimeout(60_000);
  assert.equal(handle.timeout, 360_000, "timeout should increase by extension duration");

  await handle.extendTimeout(30_000);
  assert.equal(handle.timeout, 390_000, "second extension should be additive");
  assert.deepEqual(handle.extendedTimeouts, [60_000, 30_000]);
});

test("controller: FakeSandboxController.create passes timeout to handle", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.create({ timeout: 600_000 });

  assert.equal(handle.timeout, 600_000, "handle should have the timeout from create params");
});

test("controller: FakeSandboxController.create uses default timeout when unset", async () => {
  const controller = new FakeSandboxController();
  const handle = await controller.create({});

  assert.equal(handle.timeout, 5 * 60 * 1000, "default should be 5 minutes");
});

test("controller: type exports are accessible", () => {
  // Compile-time check — these types should be importable
  const _params: CreateParams = { ports: [3000] };
  const _result: CommandResult = { exitCode: 0, output: async () => "" };
  const _snap: SnapshotResult = { snapshotId: "snap-1" };
  assert.ok(true, "type exports are accessible");
});
