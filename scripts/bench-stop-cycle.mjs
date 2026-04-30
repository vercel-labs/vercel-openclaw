#!/usr/bin/env node
/**
 * Stop-cycle benchmark: measures wall-clock time from POST /api/admin/stop
 * until the app and, optionally, the Vercel Sandbox SDK report stopped.
 * Polls every 1s and records each sample. Emits JSONL records + summary to
 * stdout.
 *
 * Usage:
 *   ADMIN_SECRET=... node scripts/bench-stop-cycle.mjs --base-url <url> --cycles=20 --sdk-poll
 *
 * Workload examples:
 *   --workload=idle
 *   --workload=status --status-hits=100
 *   --workload=home-small --sdk-poll
 *   --workload=home-large --sdk-poll
 *
 * Or via vercel curl bypass: set BYPASS_BIN=vercel and BYPASS_DEPLOYMENT=<url>
 * (this script does NOT shell out to vercel; instead, set VERCEL_AUTOMATION_BYPASS_SECRET
 *  for direct-fetch protection bypass, OR run via the deployment's public URL when
 *  protection is disabled).
 *
 * For protection-bypassed direct fetch, set VERCEL_PROTECTION_BYPASS to a token,
 * which is sent as `x-vercel-protection-bypass` header.
 *
 * Important: app-only polling can be capped by the host's stale snapshotting
 * guardrail. Use --sdk-poll when you need platform truth beyond that guardrail.
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    cycles: { type: "string", default: "3" },
    "max-wait-ms": { type: "string", default: "900000" },
    "poll-ms": { type: "string", default: "1000" },
    "use-vercel-curl": { type: "boolean", default: false },
    deployment: { type: "string" },
    "sdk-poll": { type: "boolean", default: false },
    "sandbox-name": { type: "string" },
    workload: { type: "string", default: "idle" },
    "status-hits": { type: "string", default: "0" },
    "gateway-hits": { type: "string", default: "0" },
    "fs-mb": { type: "string", default: "0" },
    "fs-files": { type: "string", default: "0" },
    "fs-dir": { type: "string" },
  },
});

const baseUrl = values["base-url"];
const cycles = Number.parseInt(values.cycles, 10);
const maxWaitMs = Number.parseInt(values["max-wait-ms"], 10);
const pollMs = Number.parseInt(values["poll-ms"], 10);
const useVercelCurl = values["use-vercel-curl"];
const deployment = values.deployment ?? baseUrl;
const sdkPoll = values["sdk-poll"];
const sandboxNameOverride = values["sandbox-name"];
const workload = values.workload;
const statusHits = Number.parseInt(values["status-hits"], 10);
const gatewayHits = Number.parseInt(values["gateway-hits"], 10);
const fsMb = Number.parseInt(values["fs-mb"], 10);
const fsFiles = Number.parseInt(values["fs-files"], 10);
const fsDir = values["fs-dir"];
const adminSecret = process.env.ADMIN_SECRET ?? "vercel-admin-secret";

if (!baseUrl) {
  process.stderr.write("error: --base-url required\n");
  process.exit(2);
}

function log(msg) {
  process.stderr.write(`[stop-bench] ${msg}\n`);
}

function emit(rec) {
  process.stdout.write(JSON.stringify(rec) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function assertPositiveInteger(name, value, { allowZero = false } = {}) {
  const ok = Number.isInteger(value) && (allowZero ? value >= 0 : value > 0);
  if (!ok) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
}

function workloadDefaults() {
  switch (workload) {
    case "idle":
      return { statusHits: 0, gatewayHits: 0, fsMb: 0, fsFiles: 0, fsDir: null };
    case "status":
      return { statusHits: statusHits || 100, gatewayHits, fsMb, fsFiles, fsDir: fsDir ?? null };
    case "gateway":
      return { statusHits, gatewayHits: gatewayHits || 50, fsMb, fsFiles, fsDir: fsDir ?? null };
    case "home-small":
      return { statusHits, gatewayHits, fsMb: fsMb || 25, fsFiles: fsFiles || 5, fsDir: fsDir ?? "/home/vercel-sandbox/.openclaw/snapshot-bench" };
    case "home-large":
      return { statusHits, gatewayHits, fsMb: fsMb || 250, fsFiles: fsFiles || 25, fsDir: fsDir ?? "/home/vercel-sandbox/.openclaw/snapshot-bench" };
    case "tmp-small":
      return { statusHits, gatewayHits, fsMb: fsMb || 25, fsFiles: fsFiles || 5, fsDir: fsDir ?? "/tmp/openclaw-snapshot-bench" };
    case "tmp-large":
      return { statusHits, gatewayHits, fsMb: fsMb || 250, fsFiles: fsFiles || 25, fsDir: fsDir ?? "/tmp/openclaw-snapshot-bench" };
    case "custom":
      return { statusHits, gatewayHits, fsMb, fsFiles, fsDir: fsDir ?? null };
    default:
      throw new Error(`unknown --workload=${workload}`);
  }
}

function callViaVercelCurl(path, method, options = {}) {
  const args = [
    "curl",
    "--deployment",
    deployment,
    path,
    "--",
    "-sS",
    "-H",
    `Authorization: Bearer ${adminSecret}`,
    "-H",
    "content-type: application/json",
  ];
  if (method === "POST") args.push("-X", "POST");
  const r = spawnSync("vercel", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`vercel curl exit=${r.status}: ${r.stderr}`);
  }
  // Strip vercel CLI noise lines (lines that don't start with '{' or '[')
  const stdout = r.stdout;
  // Find last JSON object (vercel CLI may print "Retrieving project..." etc to stdout? It typically goes to stderr)
  const trimmed = stdout.trim();
  // Responses are JSON objects; pick the first '{' as start.
  const jsonStart = trimmed.indexOf("{");
  const jsonText = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  if (options.json === false) {
    return { status: 200, body: jsonText };
  }
  try {
    return { status: 200, body: JSON.parse(jsonText) };
  } catch {
    throw new Error(`bad json from vercel curl: ${jsonText.slice(0, 500)}`);
  }
}

async function call(path, method = "GET", options = {}) {
  if (useVercelCurl) return callViaVercelCurl(path, method, options);
  const url = new URL(path, baseUrl).href;
  const headers = {
    authorization: `Bearer ${adminSecret}`,
    "content-type": "application/json",
  };
  if (process.env.VERCEL_PROTECTION_BYPASS) {
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_PROTECTION_BYPASS;
  }
  const res = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(60000),
  });
  const body = options.json === false ? await res.text() : await res.json();
  return { status: res.status, body };
}

async function getStatus() {
  return call("/api/status", "GET");
}

async function ensureRunning() {
  log("ensuring sandbox running...");
  const r = await call(`/api/admin/ensure?wait=1&timeoutMs=240000`, "POST");
  if (r.status !== 200) {
    throw new Error(`ensure failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  log(`ensure ok sandboxId=${r.body.sandboxId} waitedMs=${r.body.waitedMs}`);
  return r.body;
}

async function getSandboxName(ensureBody) {
  if (sandboxNameOverride) return sandboxNameOverride;
  if (ensureBody?.sandboxId) return ensureBody.sandboxId;
  const status = await getStatus();
  return status.body?.sandboxId ?? null;
}

async function listSandboxByName(name) {
  const { Sandbox } = await import("@vercel/sandbox");
  const result = await Sandbox.list({
    namePrefix: name,
    limit: 20,
    sortBy: "name",
  });
  return result.sandboxes.find((sandbox) => sandbox.name === name) ?? null;
}

async function getPlatformStatus(name) {
  const sandbox = await listSandboxByName(name);
  if (!sandbox) {
    return { status: "not-found" };
  }
  return {
    status: sandbox.status,
    statusUpdatedAt: sandbox.statusUpdatedAt ?? null,
    currentSnapshotId: sandbox.currentSnapshotId ?? null,
    currentSessionId: sandbox.currentSessionId ?? null,
    totalDurationMs: sandbox.totalDurationMs ?? null,
    totalActiveCpuDurationMs: sandbox.totalActiveCpuDurationMs ?? null,
  };
}

async function assertSdkPollingReady(name) {
  try {
    const platform = await getPlatformStatus(name);
    if (platform.status === "not-found") {
      throw new Error(`sandbox ${name} was not found in Sandbox.list()`);
    }
    return platform;
  } catch (error) {
    throw new Error(
      `--sdk-poll could not read ${name} through @vercel/sandbox; ` +
        `configure Vercel Sandbox credentials or omit --sdk-poll. Cause: ${error.message}`,
    );
  }
}

async function getLiveSandbox(name) {
  const { Sandbox } = await import("@vercel/sandbox");
  try {
    return await Sandbox.get({ name });
  } catch (error) {
    throw new Error(
      `failed to access sandbox ${name} through @vercel/sandbox; ` +
        `set Vercel Sandbox credentials or use an app-only workload. Cause: ${error.message}`,
    );
  }
}

async function createFilesystemDelta(name, spec) {
  if (!spec.fsDir || spec.fsMb <= 0 || spec.fsFiles <= 0) return null;
  const sandbox = await getLiveSandbox(name);
  const mbPerFile = Math.max(1, Math.ceil(spec.fsMb / spec.fsFiles));
  const script = [
    "set -eu",
    `dir=${JSON.stringify(spec.fsDir)}`,
    "rm -rf \"$dir\"",
    "mkdir -p \"$dir\"",
    `for i in $(seq 1 ${spec.fsFiles}); do`,
    `  dd if=/dev/zero of=\"$dir/file-$i.bin\" bs=1M count=${mbPerFile} status=none`,
    "done",
    "sync",
    "du -sm \"$dir\" | awk '{print $1}'",
  ].join("\n");
  const startedAt = Date.now();
  const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script] });
  const output = await result.output("stdout");
  const durationMs = Date.now() - startedAt;
  return {
    fsDir: spec.fsDir,
    requestedMb: spec.fsMb,
    requestedFiles: spec.fsFiles,
    actualMb: Number.parseInt(output.trim(), 10) || null,
    exitCode: result.exitCode,
    durationMs,
  };
}

async function prepareWorkload(cycle, sandboxName) {
  const spec = workloadDefaults();
  const startedAt = Date.now();
  log(`cycle=${cycle} preparing workload=${workload} sandbox=${sandboxName ?? "unknown"}`);

  for (let i = 0; i < spec.statusHits; i += 1) {
    await getStatus();
  }

  let gatewayOk = 0;
  for (let i = 0; i < spec.gatewayHits; i += 1) {
    const response = await call("/gateway/", "GET", { json: false }).catch(() => null);
    if (response?.status && response.status < 500) gatewayOk += 1;
  }

  const fsDelta = sandboxName ? await createFilesystemDelta(sandboxName, spec) : null;
  const rec = {
    cycle,
    type: "workload-prepared",
    workload,
    statusHits: spec.statusHits,
    gatewayHits: spec.gatewayHits,
    gatewayOk,
    fsDelta,
    durationMs: Date.now() - startedAt,
  };
  emit(rec);
  return rec;
}

async function runCycle(n) {
  const ensureBody = await ensureRunning();
  const sandboxName = await getSandboxName(ensureBody);
  if (sdkPoll && !sandboxName) {
    throw new Error("--sdk-poll requires a sandbox name; pass --sandbox-name if /api/status does not expose sandboxId");
  }
  if (sdkPoll) {
    const platform = await assertSdkPollingReady(sandboxName);
    emit({ cycle: n, type: "sdk-poll-ready", sandboxName, platform });
  }
  await prepareWorkload(n, sandboxName);
  // Brief settle
  await sleep(1000);

  const stopStart = Date.now();
  log(`cycle=${n} POST /api/admin/stop ...`);
  const stopResp = await call("/api/admin/stop", "POST");
  const stopReturnedMs = Date.now() - stopStart;
  log(
    `cycle=${n} stop returned status=${stopResp.status} after ${stopReturnedMs}ms ` +
      `body.status=${stopResp.body?.status} snapshotId=${stopResp.body?.snapshotId ?? "—"}`,
  );
  emit({
    cycle: n,
    type: "stop-response",
    httpStatus: stopResp.status,
    stopReturnedMs,
    body: stopResp.body,
  });

  const samples = [];
  let firstStoppedAtMs = null;
  let firstSnapshottingAtMs = null;
  let firstPlatformSnapshottingAtMs = null;
  let firstPlatformStoppedAtMs = null;
  let snapshottingDurationMs = null;
  let platformSnapshottingDurationMs = null;
  let lastStatus = null;
  let lastPlatformStatus = null;
  let staleGuardrailLikely = false;

  while (true) {
    const elapsed = Date.now() - stopStart;
    if (elapsed > maxWaitMs) {
      log(`cycle=${n} TIMEOUT after ${elapsed}ms, app=${lastStatus} platform=${lastPlatformStatus}`);
      emit({ cycle: n, type: "timeout", elapsedMs: elapsed, lastStatus, lastPlatformStatus });
      return {
        cycle: n,
        timedOut: true,
        samples,
        lastStatus,
        lastPlatformStatus,
        firstStoppedAtMs,
        firstPlatformStoppedAtMs,
        elapsedMs: elapsed,
      };
    }
    let st;
    try {
      st = await getStatus();
    } catch (e) {
      log(`cycle=${n} status err: ${e.message}`);
      await sleep(pollMs);
      continue;
    }
    let platform = null;
    if (sdkPoll && sandboxName) {
      try {
        platform = await getPlatformStatus(sandboxName);
      } catch (e) {
        platform = { status: "poll-error", error: e.message };
      }
    }
    const s = st.body?.status;
    const platformStatus = platform?.status ?? null;
    const sample = {
      cycle: n,
      type: "poll",
      elapsedMs: elapsed,
      status: s,
      platformStatus,
      platform,
      lastError: st.body?.lastError ?? null,
      sandboxId: st.body?.sandboxId ?? null,
      snapshotId: st.body?.snapshotId ?? null,
    };
    samples.push(sample);
    emit(sample);
    if (s === "snapshotting" && firstSnapshottingAtMs === null) {
      firstSnapshottingAtMs = elapsed;
    }
    if (platformStatus === "snapshotting" && firstPlatformSnapshottingAtMs === null) {
      firstPlatformSnapshottingAtMs = elapsed;
    }
    if (platformStatus === "stopped") {
      if (firstPlatformStoppedAtMs === null) firstPlatformStoppedAtMs = elapsed;
      if (firstPlatformSnapshottingAtMs !== null) {
        platformSnapshottingDurationMs = firstPlatformStoppedAtMs - firstPlatformSnapshottingAtMs;
      }
    }
    if (s === "stopped") {
      if (firstStoppedAtMs === null) firstStoppedAtMs = elapsed;
      if (firstSnapshottingAtMs !== null) {
        snapshottingDurationMs = firstStoppedAtMs - firstSnapshottingAtMs;
      }
      if (sdkPoll && platformStatus !== "stopped") {
        staleGuardrailLikely = elapsed >= 5 * 60 * 1000;
      } else {
        break;
      }
    }
    if (platformStatus === "stopped" && (!sdkPoll || firstStoppedAtMs !== null)) {
      break;
    }
    if (s === "error") {
      log(`cycle=${n} reached error state lastError=${st.body?.lastError}`);
      break;
    }
    lastStatus = s;
    lastPlatformStatus = platformStatus;
    await sleep(pollMs);
  }

  const totalMs = Date.now() - stopStart;

  // Now wake and capture lastRestoreMetrics, which may include snapshotMs from the prior stop
  log(
    `cycle=${n} stop->app-stopped=${firstStoppedAtMs}ms ` +
      `stop->platform-stopped=${firstPlatformStoppedAtMs ?? "n/a"}ms, now waking to capture metrics...`,
  );
  let restoreMetrics = null;
  try {
    const wake = await call(`/api/admin/ensure?wait=1&timeoutMs=240000`, "POST");
    if (wake.status === 200) {
      const after = await getStatus();
      restoreMetrics = after.body?.lifecycle?.lastRestoreMetrics ?? null;
    }
  } catch (e) {
    log(`cycle=${n} wake-after err: ${e.message}`);
  }

  const summary = {
    cycle: n,
    type: "cycle-summary",
    stopReturnedMs,
    firstSnapshottingAtMs,
    firstStoppedAtMs,
    firstPlatformSnapshottingAtMs,
    firstPlatformStoppedAtMs,
    snapshottingDurationMs,
    platformSnapshottingDurationMs,
    staleGuardrailLikely,
    totalMs,
    sandboxName,
    workload,
    sampleCount: samples.length,
    restoreMetricsAfter: restoreMetrics,
  };
  emit(summary);
  log(
    `cycle=${n} DONE stopReturned=${stopReturnedMs}ms snapshotting@${firstSnapshottingAtMs}ms ` +
      `appStopped@${firstStoppedAtMs}ms platformStopped@${firstPlatformStoppedAtMs ?? "n/a"}ms ` +
      `appSnapshottingFor=${snapshottingDurationMs}ms platformSnapshottingFor=${platformSnapshottingDurationMs ?? "n/a"}ms`,
  );
  return summary;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stat(values) {
  const arr = values.filter((v) => typeof v === "number");
  return {
    count: arr.length,
    p50: pct(arr, 50),
    p95: pct(arr, 95),
    max: arr.length ? Math.max(...arr) : null,
    min: arr.length ? Math.min(...arr) : null,
  };
}

(async () => {
  assertPositiveInteger("--cycles", cycles);
  assertPositiveInteger("--max-wait-ms", maxWaitMs);
  assertPositiveInteger("--poll-ms", pollMs);
  assertPositiveInteger("--status-hits", finiteNumber(statusHits, NaN), { allowZero: true });
  assertPositiveInteger("--gateway-hits", finiteNumber(gatewayHits, NaN), { allowZero: true });
  assertPositiveInteger("--fs-mb", finiteNumber(fsMb, NaN), { allowZero: true });
  assertPositiveInteger("--fs-files", finiteNumber(fsFiles, NaN), { allowZero: true });
  workloadDefaults();
  log(
    `starting cycles=${cycles} base=${baseUrl} useVercelCurl=${useVercelCurl} ` +
      `sdkPoll=${sdkPoll} workload=${workload} maxWaitMs=${maxWaitMs}`,
  );
  const results = [];
  for (let i = 1; i <= cycles; i++) {
    try {
      const r = await runCycle(i);
      results.push(r);
    } catch (e) {
      log(`cycle=${i} FAIL ${e.message}`);
      emit({ cycle: i, type: "cycle-error", error: e.message });
    }
  }

  const stopReturned = results.map((r) => r.stopReturnedMs).filter((v) => typeof v === "number");
  const firstStopped = results.map((r) => r.firstStoppedAtMs).filter((v) => typeof v === "number");
  const firstPlatformStopped = results.map((r) => r.firstPlatformStoppedAtMs).filter((v) => typeof v === "number");
  const snapDuration = results
    .map((r) => r.snapshottingDurationMs)
    .filter((v) => typeof v === "number");
  const platformSnapDuration = results
    .map((r) => r.platformSnapshottingDurationMs)
    .filter((v) => typeof v === "number");
  const summary = {
    type: "summary",
    cycles: results.length,
    completeCycles: results.filter((r) => !r.timedOut).length,
    timedOutCycles: results.filter((r) => r.timedOut).length,
    sdkPoll,
    workload,
    stopReturnedMs: stat(stopReturned),
    appStopToStoppedMs: stat(firstStopped),
    platformStopToStoppedMs: stat(firstPlatformStopped),
    appSnapshottingDurationMs: stat(snapDuration),
    platformSnapshottingDurationMs: stat(platformSnapDuration),
    staleGuardrailLikelyCycles: results.filter((r) => r.staleGuardrailLikely).length,
    results,
  };
  emit(summary);
  log("ALL DONE");
})().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
