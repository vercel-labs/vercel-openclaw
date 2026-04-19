#!/usr/bin/env node
/**
 * Audit: does Sandbox.get() on a stopped persistent sandbox auto-resume?
 *
 * Questions answered:
 *   A. After stop({ blocking: true }), what status does Sandbox.get() return?
 *   B. Does calling runCommand() on that handle trigger an implicit resume?
 *   C. If (B) throws, does Sandbox.create({ name, persistent }) on the same
 *      name trigger a resume (and how long does it take)?
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

const ms = (t) => Math.round(performance.now() - t);
const log = (event, data = {}) =>
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n");

const NAME = `oc-resume-audit-${Date.now()}`;
const MARKER = `marker-${randomUUID()}`;
let sandbox = null;

try {
  // 1) create persistent sandbox and write marker
  log("create.start", { name: NAME });
  const createStart = performance.now();
  sandbox = await Sandbox.create({
    name: NAME,
    persistent: true,
    timeout: 5 * 60_000,
    resources: { vcpus: 1 },
  });
  log("create.done", {
    createMs: ms(createStart),
    sandboxId: sandbox.sandboxId,
    status: sandbox.status,
  });
  await sandbox.writeFiles([
    { path: "/tmp/marker.txt", content: Buffer.from(MARKER) },
  ]);
  log("marker.written");

  // 2) stop with blocking: true so we KNOW the sandbox is fully stopped
  log("stop.start");
  const stopStart = performance.now();
  await sandbox.stop({ blocking: true });
  log("stop.done", { stopMs: ms(stopStart) });

  // 3) Sandbox.get() — what does it return?
  log("getA.start");
  const getAStart = performance.now();
  const handleA = await Sandbox.get({ name: NAME });
  log("getA.done", {
    getMs: ms(getAStart),
    status: handleA.status,
    sandboxId: handleA.sandboxId,
  });

  // 4) runCommand on the stopped handle — does it auto-resume or throw?
  log("runcmd.start", { handleStatus: handleA.status });
  const cmdStart = performance.now();
  let runCmdError = null;
  let runCmdResult = null;
  try {
    const r = await handleA.runCommand("echo", ["hello"]);
    runCmdResult = {
      exitCode: r.exitCode,
      stdout: (await r.output("stdout")).trim(),
    };
    log("runcmd.done", { cmdMs: ms(cmdStart), ...runCmdResult });
  } catch (err) {
    runCmdError = { message: err.message, name: err.name };
    log("runcmd.error", { cmdMs: ms(cmdStart), ...runCmdError });
  }

  // 5) Re-check status via get() to see whether step (4) resumed the sandbox
  const handleB = await Sandbox.get({ name: NAME });
  log("getB.after_runcmd", { status: handleB.status });

  // 6) If runCommand errored OR handle still stopped, try create-by-name
  let createResumeMs = null;
  let createResumeStatus = null;
  if (runCmdError || handleB.status !== "running") {
    log("createResume.start");
    const crStart = performance.now();
    try {
      const resumed = await Sandbox.create({
        name: NAME,
        persistent: true,
        timeout: 5 * 60_000,
        resources: { vcpus: 1 },
      });
      createResumeMs = ms(crStart);
      createResumeStatus = resumed.status;
      sandbox = resumed;
      log("createResume.done", {
        createResumeMs,
        status: createResumeStatus,
        sandboxId: resumed.sandboxId,
      });

      // Verify marker survived
      const mark = await resumed.runCommand("cat", ["/tmp/marker.txt"]);
      const stdout = (await mark.output("stdout")).trim();
      log("createResume.marker_check", {
        survived: stdout === MARKER,
        actual: stdout.slice(0, 80),
      });
    } catch (err) {
      log("createResume.error", { error: err.message });
    }
  } else {
    sandbox = handleB;
  }

  log("SUMMARY", {
    name: NAME,
    afterStopGetStatus: handleA.status,
    runCommandOnStoppedHandle: runCmdError
      ? { threw: true, error: runCmdError }
      : { threw: false, result: runCmdResult },
    statusAfterRunCommand: handleB.status,
    createByNameResumeMs: createResumeMs,
    createByNameStatus: createResumeStatus,
  });
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
