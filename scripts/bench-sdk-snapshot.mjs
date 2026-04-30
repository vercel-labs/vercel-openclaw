#!/usr/bin/env node
/**
 * Direct Vercel Sandbox snapshot benchmark.
 *
 * Creates disposable persistent sandboxes in the linked Vercel project,
 * optionally writes controlled filesystem deltas, calls stop({ blocking:false }),
 * and polls Sandbox.list() until the platform reports status="stopped".
 *
 * Usage:
 *   node --env-file=.env.local scripts/bench-sdk-snapshot.mjs --cycles=5 --workload=idle
 *   node --env-file=.env.local scripts/bench-sdk-snapshot.mjs --cycles=5 --workload=home-small
 *   node --env-file=.env.local scripts/bench-sdk-snapshot.mjs --cycles=1 --workload=custom --setup-cmd 'npm init -y && npm install openclaw@2026.4.12'
 *   node --env-file=.env.local scripts/bench-sdk-snapshot.mjs --cycles=1 --workload=bundle --bundle-url https://...
 */
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

import { Sandbox } from "@vercel/sandbox";

const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "3" },
    workload: { type: "string", default: "idle" },
    "poll-ms": { type: "string", default: "1000" },
    "max-wait-ms": { type: "string", default: "900000" },
    "fs-mb": { type: "string", default: "0" },
    "fs-files": { type: "string", default: "0" },
    "fs-dir": { type: "string" },
    "name-prefix": { type: "string", default: "openclaw-snapbench" },
    vcpus: { type: "string", default: "1" },
    timeout: { type: "string", default: "600000" },
    "keep-sandboxes": { type: "boolean", default: false },
    "setup-cmd": { type: "string" },
    "data-pattern": { type: "string", default: "zero" },
    "bundle-url": { type: "string" },
    "start-bundle": { type: "boolean", default: false },
    "bundle-run-ms": { type: "string", default: "0" },
  },
});

const cycles = Number.parseInt(values.cycles, 10);
const workload = values.workload;
const pollMs = Number.parseInt(values["poll-ms"], 10);
const maxWaitMs = Number.parseInt(values["max-wait-ms"], 10);
const fsMb = Number.parseInt(values["fs-mb"], 10);
const fsFiles = Number.parseInt(values["fs-files"], 10);
const fsDir = values["fs-dir"];
const namePrefix = values["name-prefix"];
const vcpus = Number.parseInt(values.vcpus, 10);
const timeout = Number.parseInt(values.timeout, 10);
const keepSandboxes = values["keep-sandboxes"];
const setupCmd = values["setup-cmd"];
const dataPattern = values["data-pattern"];
const bundleUrl = values["bundle-url"];
const startBundle = values["start-bundle"];
const bundleRunMs = Number.parseInt(values["bundle-run-ms"], 10);

function log(message) {
  process.stderr.write(`[sdk-snapbench] ${message}\n`);
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function assertInteger(name, value, { allowZero = false } = {}) {
  const ok = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0);
  if (!ok) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
}

function workloadSpec() {
  switch (workload) {
    case "idle":
      return { fsMb: 0, fsFiles: 0, fsDir: null };
    case "home-small":
      return {
        fsMb: fsMb || 25,
        fsFiles: fsFiles || 5,
        fsDir: fsDir ?? "/home/vercel-sandbox/.openclaw/snapshot-bench",
      };
    case "home-large":
      return {
        fsMb: fsMb || 250,
        fsFiles: fsFiles || 25,
        fsDir: fsDir ?? "/home/vercel-sandbox/.openclaw/snapshot-bench",
      };
    case "tmp-small":
      return {
        fsMb: fsMb || 25,
        fsFiles: fsFiles || 5,
        fsDir: fsDir ?? "/tmp/openclaw-snapshot-bench",
      };
    case "tmp-large":
      return {
        fsMb: fsMb || 250,
        fsFiles: fsFiles || 25,
        fsDir: fsDir ?? "/tmp/openclaw-snapshot-bench",
      };
    case "custom":
      return { fsMb, fsFiles, fsDir: fsDir ?? null };
    case "bundle":
      if (!bundleUrl) throw new Error("--workload=bundle requires --bundle-url");
      return { fsMb, fsFiles, fsDir: fsDir ?? null };
    default:
      throw new Error(`unknown --workload=${workload}`);
  }
}

async function commandOutput(command) {
  const stdout = await command.output("stdout");
  const stderr = await command.output("stderr");
  return { stdout, stderr };
}

async function getSandboxMeta(name) {
  const result = await Sandbox.list({
    namePrefix: name,
    sortBy: "name",
    limit: 20,
  });
  return result.sandboxes.find((sandbox) => sandbox.name === name) ?? null;
}

async function waitForStatus(name, desired, startedAt) {
  let firstSnapshottingAtMs = null;
  let last = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    const elapsedMs = Date.now() - startedAt;
    const meta = await getSandboxMeta(name);
    const status = meta?.status ?? "not-found";
    last = {
      status,
      currentSnapshotId: meta?.currentSnapshotId ?? null,
      currentSessionId: meta?.currentSessionId ?? null,
      statusUpdatedAt: meta?.statusUpdatedAt ?? null,
      totalDurationMs: meta?.totalDurationMs ?? null,
      totalActiveCpuDurationMs: meta?.totalActiveCpuDurationMs ?? null,
    };
    emit({ type: "poll", name, elapsedMs, ...last });

    if (status === "snapshotting" && firstSnapshottingAtMs === null) {
      firstSnapshottingAtMs = elapsedMs;
    }
    if (status === desired) {
      return { elapsedMs, firstSnapshottingAtMs, last };
    }
    if (status === "failed" || status === "aborted") {
      throw new Error(`sandbox ${name} reached ${status}`);
    }
    await sleep(pollMs);
  }

  return { timedOut: true, elapsedMs: Date.now() - startedAt, firstSnapshottingAtMs, last };
}

async function prepareFilesystemDelta(sandbox, spec) {
  if (!spec.fsDir || spec.fsMb <= 0 || spec.fsFiles <= 0) return null;
  const mbPerFile = Math.max(1, Math.ceil(spec.fsMb / spec.fsFiles));
  const script = [
    "set -eu",
    `dir=${JSON.stringify(spec.fsDir)}`,
    "rm -rf \"$dir\"",
    "mkdir -p \"$dir\"",
    `for i in $(seq 1 ${spec.fsFiles}); do`,
    dataPattern === "random"
      ? `  dd if=/dev/urandom of=\"$dir/file-$i.bin\" bs=1M count=${mbPerFile} status=none`
      : `  dd if=/dev/zero of=\"$dir/file-$i.bin\" bs=1M count=${mbPerFile} status=none`,
    "done",
    "sync",
    "du -sm \"$dir\" | awk '{print $1}'",
  ].join("\n");
  const startedAt = Date.now();
  const command = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
  const { stdout, stderr } = await commandOutput(command);
  const durationMs = Date.now() - startedAt;
  if (command.exitCode !== 0) {
    throw new Error(`filesystem workload failed exit=${command.exitCode}: ${stderr || stdout}`);
  }
  return {
    fsDir: spec.fsDir,
    requestedMb: spec.fsMb,
    requestedFiles: spec.fsFiles,
    actualMb: Number.parseInt(stdout.trim(), 10) || null,
    durationMs,
  };
}

async function runSetupCommand(sandbox) {
  if (!setupCmd) return null;
  const startedAt = Date.now();
  const command = await sandbox.runCommand({ cmd: "bash", args: ["-lc", setupCmd] });
  const { stdout, stderr } = await commandOutput(command);
  const durationMs = Date.now() - startedAt;
  const result = {
    cmd: setupCmd,
    exitCode: command.exitCode,
    durationMs,
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr.slice(-2000),
  };
  if (command.exitCode !== 0) {
    throw new Error(`setup command failed exit=${command.exitCode}: ${result.stderrTail || result.stdoutTail}`);
  }
  return result;
}

async function runCommandChecked(sandbox, label, script) {
  const startedAt = Date.now();
  const command = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
  const { stdout, stderr } = await commandOutput(command);
  const durationMs = Date.now() - startedAt;
  const result = {
    label,
    exitCode: command.exitCode,
    durationMs,
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr.slice(-2000),
  };
  if (command.exitCode !== 0) {
    throw new Error(`${label} failed exit=${command.exitCode}: ${result.stderrTail || result.stdoutTail}`);
  }
  return result;
}

async function prepareBundleWorkload(sandbox) {
  if (workload !== "bundle") return null;
  const artifact = (name) => JSON.stringify(new URL(name, bundleUrl).href);
  const base = JSON.stringify(bundleUrl);
  const commands = [];

  commands.push(await runCommandChecked(sandbox, "bundle-download-core", [
    "set -eu",
    `curl -fsSL --max-time 120 --connect-timeout 10 -o /home/vercel-sandbox/openclaw.bundle.mjs ${base}`,
    `echo '{"name":"openclaw","private":true}' > /home/vercel-sandbox/package.json`,
    "mkdir -p /home/vercel-sandbox/dist /home/vercel-sandbox/docs/reference /home/vercel-sandbox/.openclaw/agents/main/agent",
    `curl -fsSL --max-time 10 --connect-timeout 5 -o /home/vercel-sandbox/dist/channel-catalog.json ${artifact("channel-catalog.json")}`,
    `curl -fsSL --max-time 15 --connect-timeout 5 ${artifact("workspace-templates.tar.gz")} | tar xz -C /home/vercel-sandbox/docs/reference`,
    `printf '%s' '{"version":1,"profiles":{"vercel-ai-gateway:default":{"type":"api_key","provider":"vercel-ai-gateway","key":"sk-placeholder-injected-via-network-policy"}}}' > /home/vercel-sandbox/.openclaw/agents/main/agent/auth-profiles.json`,
  ].join(" && ")));

  for (const [label, filename, target] of [
    ["bundle-download-channels", "channels.tar.gz", "/home/vercel-sandbox/extensions"],
    ["bundle-download-deps", "bundle-deps.tar.gz", "/home/vercel-sandbox"],
    ["bundle-download-openclaw-pkg", "bundle-openclaw-pkg.tar.gz", "/home/vercel-sandbox"],
    ["bundle-download-shared-chunks", "channel-shared-chunks.tar.gz", "/home/vercel-sandbox"],
  ]) {
    commands.push(await runCommandChecked(sandbox, label, [
      "set -eu",
      `mkdir -p ${JSON.stringify(target)}`,
      `curl -fsSL --max-time 60 --connect-timeout 10 ${artifact(filename)} | tar xz -C ${JSON.stringify(target)}`,
    ].join(" && ")));
  }

  commands.push(await runCommandChecked(sandbox, "bundle-version", "node /home/vercel-sandbox/openclaw.bundle.mjs --version"));

  let detached = null;
  if (startBundle) {
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", "cd /home/vercel-sandbox && nohup node /home/vercel-sandbox/openclaw.bundle.mjs --port 3000 > /tmp/openclaw.log 2>&1 & echo $!"],
    });
    const { stdout, stderr } = await commandOutput(command);
    detached = { exitCode: command.exitCode, pid: stdout.trim(), stderrTail: stderr.slice(-2000) };
    if (command.exitCode !== 0) throw new Error(`bundle start failed: ${stderr || stdout}`);
    if (bundleRunMs > 0) await sleep(bundleRunMs);
  }

  const size = await runCommandChecked(
    sandbox,
    "bundle-size",
    "du -sm /home/vercel-sandbox /tmp 2>/dev/null || true",
  );
  return { bundleUrl, startBundle, bundleRunMs, commands, detached, size };
}

async function runCycle(cycle) {
  const name = `${namePrefix}-${Date.now()}-${cycle}`.toLowerCase();
  log(`cycle=${cycle} creating ${name}`);
  const createStartedAt = Date.now();
  const sandbox = await Sandbox.create({
    name,
    persistent: true,
    ports: [],
    timeout,
    resources: { vcpus },
  });
  const createMs = Date.now() - createStartedAt;
  emit({ type: "created", cycle, name, createMs, status: sandbox.status });

  let deleted = false;
  try {
    const spec = workloadSpec();
    const workloadStartedAt = Date.now();
    const setup = await runSetupCommand(sandbox);
    const bundle = await prepareBundleWorkload(sandbox);
    const fsDelta = await prepareFilesystemDelta(sandbox, spec);
    const workloadMs = Date.now() - workloadStartedAt;
    emit({ type: "workload-prepared", cycle, name, workload, setup, bundle, fsDelta, workloadMs });

    const stopStartedAt = Date.now();
    const stopSnapshot = await sandbox.stop({ blocking: false });
    const stopReturnedMs = Date.now() - stopStartedAt;
    emit({
      type: "stop-response",
      cycle,
      name,
      stopReturnedMs,
      sdkStatusAtReturn: stopSnapshot.status ?? null,
      currentSnapshotId: stopSnapshot.currentSnapshotId ?? null,
    });

    if (stopSnapshot.status === "stopped") {
      const summary = {
        type: "cycle-summary",
        cycle,
        name,
        workload,
        createMs,
        workloadMs,
        stopReturnedMs,
        stopToStoppedMs: stopReturnedMs,
        firstSnapshottingAtMs: null,
        snapshottingDurationMs: 0,
        timedOut: false,
        last: {
          status: "stopped",
          currentSnapshotId: stopSnapshot.currentSnapshotId ?? null,
          currentSessionId: null,
          statusUpdatedAt: null,
          totalDurationMs: null,
          totalActiveCpuDurationMs: null,
        },
      };
      emit(summary);
      if (!keepSandboxes) {
        await sandbox.delete().catch((error) => {
          log(`cycle=${cycle} delete failed for ${name}: ${error.message}`);
        });
        deleted = true;
      }
      return summary;
    }

    const stopped = await waitForStatus(name, "stopped", stopStartedAt);
    const stopToStoppedMs = stopped.elapsedMs;
    const snapshottingDurationMs = stopped.firstSnapshottingAtMs === null
      ? null
      : stopToStoppedMs - stopped.firstSnapshottingAtMs;
    const summary = {
      type: "cycle-summary",
      cycle,
      name,
      workload,
      createMs,
      workloadMs,
      stopReturnedMs,
      stopToStoppedMs,
      firstSnapshottingAtMs: stopped.firstSnapshottingAtMs,
      snapshottingDurationMs,
      timedOut: stopped.timedOut === true,
      last: stopped.last,
    };
    emit(summary);

    if (!keepSandboxes) {
      await sandbox.delete().catch((error) => {
        log(`cycle=${cycle} delete failed for ${name}: ${error.message}`);
      });
      deleted = true;
    }
    return summary;
  } finally {
    if (!keepSandboxes && !deleted) {
      await sandbox.delete().catch((error) => {
        log(`cleanup delete failed for ${name}: ${error.message}`);
      });
    }
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function stats(values) {
  const numbers = values.filter((value) => typeof value === "number");
  return {
    count: numbers.length,
    min: numbers.length ? Math.min(...numbers) : null,
    p50: percentile(numbers, 50),
    p95: percentile(numbers, 95),
    max: numbers.length ? Math.max(...numbers) : null,
  };
}

async function main() {
  assertInteger("--cycles", cycles);
  assertInteger("--poll-ms", pollMs);
  assertInteger("--max-wait-ms", maxWaitMs);
  assertInteger("--fs-mb", fsMb, { allowZero: true });
  assertInteger("--fs-files", fsFiles, { allowZero: true });
  assertInteger("--vcpus", vcpus);
  assertInteger("--timeout", timeout);
  assertInteger("--bundle-run-ms", bundleRunMs, { allowZero: true });
  workloadSpec();

  log(`starting cycles=${cycles} workload=${workload} prefix=${namePrefix} keep=${keepSandboxes}`);
  const results = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    try {
      results.push(await runCycle(cycle));
    } catch (error) {
      log(`cycle=${cycle} failed: ${error.message}`);
      emit({ type: "cycle-error", cycle, error: error.message });
    }
  }

  emit({
    type: "summary",
    cycles,
    completed: results.filter((result) => !result.timedOut).length,
    timedOut: results.filter((result) => result.timedOut).length,
    workload,
    createMs: stats(results.map((result) => result.createMs)),
    workloadMs: stats(results.map((result) => result.workloadMs)),
    stopReturnedMs: stats(results.map((result) => result.stopReturnedMs)),
    stopToStoppedMs: stats(results.map((result) => result.stopToStoppedMs)),
    snapshottingDurationMs: stats(results.map((result) => result.snapshottingDurationMs)),
    results,
  });
}

main().catch((error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
