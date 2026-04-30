#!/usr/bin/env node

/**
 * Benchmark: compare sandbox bootstrap AND wake-from-sleep for
 * npm-install vs esbuild-bundle paths.
 *
 * Three phases per mode:
 *   1. BOOTSTRAP — create sandbox, install/upload openclaw, start gateway, probe readiness
 *   2. SNAPSHOT  — snapshot the running sandbox
 *   3. WAKE     — restore from snapshot, re-start gateway, probe readiness (repeated N cycles)
 *
 * Requires OIDC credentials: run `vercel link && vercel env pull` first.
 *
 * Usage:
 *   node scripts/bench-bundle-bootstrap.mjs
 *   node scripts/bench-bundle-bootstrap.mjs --bundle-path ~/dev/openclaw/dist-vercel-runtime/moonshot/openclaw.bundle.cjs
 *   node scripts/bench-bundle-bootstrap.mjs --skip-baseline
 *   node scripts/bench-bundle-bootstrap.mjs --cycles=3
 *   node scripts/bench-bundle-bootstrap.mjs --wake-cycles=5
 */

import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .env.local loader
// ---------------------------------------------------------------------------

function loadEnv() {
  try {
    const envPath = resolve(__dirname, "../.env.local");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      let val = trimmed.slice(eq + 1);
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch {
    // rely on already-set env vars
  }
}

loadEnv();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_BUNDLE = resolve(
  __dirname,
  "../../openclaw/dist-vercel-runtime/moonshot/openclaw.bundle.cjs"
);

const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "3" },
    "wake-cycles": { type: "string", default: "3" },
    "bundle-path": { type: "string", default: DEFAULT_BUNDLE },
    "skip-baseline": { type: "boolean", default: false },
    "skip-bundle": { type: "boolean", default: false },
    "skip-wake": { type: "boolean", default: false },
    "package-spec": { type: "string", default: "openclaw@latest" },
    "timeout-ms": { type: "string", default: "300000" },
    vcpus: { type: "string", default: "1" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`bench-bundle-bootstrap — compare npm-install vs esbuild-bundle bootstrap + wake

OPTIONS
  --cycles           Bootstrap trials per mode (default: 3)
  --wake-cycles      Snapshot restore trials per mode (default: 3)
  --bundle-path      Path to openclaw.bundle.cjs
  --skip-baseline    Skip the npm-install baseline
  --skip-bundle      Skip the bundle mode
  --skip-wake        Skip the wake-from-sleep benchmark
  --package-spec     npm package spec for baseline (default: openclaw@latest)
  --timeout-ms       Sandbox timeout (default: 300000)
  --vcpus            vCPUs (default: 1)
`);
  process.exit(0);
}

const CYCLES = Number(values.cycles);
const WAKE_CYCLES = Number(values["wake-cycles"]);
const BUNDLE_PATH = values["bundle-path"];
const SKIP_BASELINE = values["skip-baseline"];
const SKIP_BUNDLE = values["skip-bundle"];
const SKIP_WAKE = values["skip-wake"];
const PACKAGE_SPEC = values["package-spec"];
const TIMEOUT_MS = Number(values["timeout-ms"]);
const VCPUS = Number(values.vcpus);

const OPENCLAW_BIN = "/home/vercel-sandbox/.global/npm/bin/openclaw";
const BUNDLE_DEST = "/home/vercel-sandbox/openclaw.bundle.cjs";
const GW_TOKEN = `bench-gw-${Date.now()}`;
const STATE_DIR = "/home/vercel-sandbox/.openclaw";
const CONFIG_PATH = `${STATE_DIR}/openclaw.json`;
const TOKEN_PATH = `${STATE_DIR}/.gateway-token`;
const LOG_FILE = "/tmp/openclaw.log";
const STARTUP_SCRIPT = "/vercel/sandbox/.on-restore.sh";

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

const { Sandbox } = await import("@vercel/sandbox");

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

function summarize(vals) {
  const sorted = [...vals].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
  };
}

// ---------------------------------------------------------------------------
// Shared: minimal gateway config + startup/restore scripts
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = JSON.stringify({
  gateway: {
    mode: "local",
    auth: { mode: "token" },
    trustedProxies: ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    controlUi: { dangerouslyDisableDeviceAuth: true },
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
}, null, 2);

function makeStartupScript(openclawCmd) {
  return `#!/bin/bash
set -euo pipefail
gateway_token="$(cat ${TOKEN_PATH})"
export OPENCLAW_CONFIG_PATH="${CONFIG_PATH}"
export OPENCLAW_GATEWAY_TOKEN="$gateway_token"
export OPENCLAW_GATEWAY_PORT="3000"
export OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS="vercel-ai-gateway"
export OPENCLAW_AGENT_RUNTIME="none"
_gw_pids="$(ps aux | grep '[o]penclaw.gateway' | awk '{print $2}' || true)"
if [ -n "$_gw_pids" ]; then kill $_gw_pids 2>/dev/null; sleep 0.5; fi
true
setsid ${openclawCmd} gateway --port 3000 --bind loopback >> ${LOG_FILE} 2>&1 &
`;
}

async function writeGatewayFiles(sandbox, openclawCmd) {
  await sandbox.writeFiles([
    { path: CONFIG_PATH, content: MINIMAL_CONFIG },
    { path: TOKEN_PATH, content: GW_TOKEN },
    { path: STARTUP_SCRIPT, content: makeStartupScript(openclawCmd), mode: 0o755 },
  ]);
}

async function probeGatewayReady(sandbox, maxAttempts = 120) {
  for (let i = 0; i < maxAttempts; i++) {
    const probe = await sandbox.runCommand("curl", [
      "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2",
      "http://localhost:3000/",
    ]);
    const statusCode = (await probe.output("stdout")).trim();
    if (probe.exitCode === 0 && statusCode !== "000") {
      return { ready: true, attempts: i + 1, statusCode };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ready: false, attempts: maxAttempts };
}

async function collectDiagnostics(sandbox) {
  const logTail = await sandbox.runCommand("tail", ["-50", LOG_FILE]);
  const logOutput = await logTail.output();
  const ps = await sandbox.runCommand("ps", ["aux"]);
  const psOutput = await ps.output();
  return { log: logOutput.slice(0, 1000), ps: psOutput.slice(0, 500) };
}

// ---------------------------------------------------------------------------
// Baseline: npm install -g + gateway start + snapshot + wake
// ---------------------------------------------------------------------------

async function benchBaselineFull(cycle) {
  log(`\n  [baseline] cycle ${cycle}/${CYCLES}`);
  const t0 = Date.now();

  // Create
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: VCPUS },
  });
  const createMs = Date.now() - t0;
  log(`    sandbox created in ${createMs}ms`);

  // Install
  const installStart = Date.now();
  const installResult = await sandbox.runCommand("npm", [
    "install", "-g", PACKAGE_SPEC, "--ignore-scripts",
  ]);
  const installMs = Date.now() - installStart;
  if (installResult.exitCode !== 0) {
    const out = await installResult.output("both");
    log(`    ❌ npm install failed: ${out.slice(0, 500)}`);
    return { cycle, mode: "baseline", error: "npm install failed" };
  }
  log(`    npm install in ${installMs}ms`);

  // Write config + startup script, start gateway
  await sandbox.runCommand("mkdir", ["-p", STATE_DIR]);
  await writeGatewayFiles(sandbox, OPENCLAW_BIN);

  const gwStart = Date.now();
  await sandbox.runCommand("bash", [STARTUP_SCRIPT]);
  const readiness = await probeGatewayReady(sandbox);
  const gatewayReadyMs = Date.now() - gwStart;

  if (!readiness.ready) {
    const diag = await collectDiagnostics(sandbox);
    log(`    ❌ gateway never ready. log: ${diag.log}`);
    return { cycle, mode: "baseline", error: "gateway not ready", createMs, installMs };
  }
  log(`    gateway ready in ${gatewayReadyMs}ms (${readiness.attempts} probes)`);

  const bootstrapMs = Date.now() - t0;
  log(`    bootstrap total: ${bootstrapMs}ms`);

  // Snapshot
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const snapshotMs = Date.now() - snapStart;
  log(`    snapshot in ${snapshotMs}ms (${snap.snapshotId})`);

  return {
    cycle,
    mode: "baseline",
    createMs,
    installMs,
    gatewayReadyMs,
    bootstrapMs,
    snapshotMs,
    snapshotId: snap.snapshotId,
  };
}

// ---------------------------------------------------------------------------
// Bundle: writeFiles + gateway start + snapshot + wake
// ---------------------------------------------------------------------------

async function benchBundleFull(cycle) {
  log(`\n  [bundle] cycle ${cycle}/${CYCLES}`);
  const t0 = Date.now();
  const bundleContent = readFileSync(BUNDLE_PATH);

  // Create
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: VCPUS },
  });
  const createMs = Date.now() - t0;
  log(`    sandbox created in ${createMs}ms`);

  // Upload bundle
  const uploadStart = Date.now();
  await sandbox.writeFiles([
    { path: BUNDLE_DEST, content: bundleContent, mode: 0o755 },
  ]);
  const uploadMs = Date.now() - uploadStart;
  log(`    bundle uploaded (${(bundleContent.length / 1024 / 1024).toFixed(1)}MB) in ${uploadMs}ms`);

  // Write config + startup script + minimal package.json (gateway expects it)
  const openclawCmd = `node ${BUNDLE_DEST}`;
  await sandbox.runCommand("mkdir", ["-p", STATE_DIR]);
  await sandbox.writeFiles([
    { path: "/home/vercel-sandbox/package.json", content: '{"name":"openclaw-sandbox","private":true}' },
  ]);
  await writeGatewayFiles(sandbox, openclawCmd);

  const gwStart = Date.now();
  await sandbox.runCommand("bash", [STARTUP_SCRIPT]);
  const readiness = await probeGatewayReady(sandbox);
  const gatewayReadyMs = Date.now() - gwStart;

  if (!readiness.ready) {
    const diag = await collectDiagnostics(sandbox);
    log(`    ❌ gateway never ready. log: ${diag.log}`);
    return { cycle, mode: "bundle", error: "gateway not ready", createMs, uploadMs };
  }
  log(`    gateway ready in ${gatewayReadyMs}ms (${readiness.attempts} probes)`);

  const bootstrapMs = Date.now() - t0;
  log(`    bootstrap total: ${bootstrapMs}ms`);

  // Snapshot
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const snapshotMs = Date.now() - snapStart;
  log(`    snapshot in ${snapshotMs}ms (${snap.snapshotId})`);

  return {
    cycle,
    mode: "bundle",
    createMs,
    uploadMs,
    gatewayReadyMs,
    bootstrapMs,
    snapshotMs,
    snapshotId: snap.snapshotId,
  };
}

// ---------------------------------------------------------------------------
// Wake from sleep: restore from snapshot → gateway ready
// ---------------------------------------------------------------------------

async function benchWake(snapshotId, mode, cycle) {
  log(`\n  [${mode} wake] cycle ${cycle}/${WAKE_CYCLES}`);
  const t0 = Date.now();

  // Restore from snapshot
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    ports: [3000],
    timeout: TIMEOUT_MS,
    resources: { vcpus: VCPUS },
  });
  const restoreMs = Date.now() - t0;
  log(`    restored in ${restoreMs}ms`);

  // The on-restore script runs automatically via STARTUP_SCRIPT path.
  // But we also explicitly run it to ensure the gateway restarts cleanly.
  const gwStart = Date.now();
  await sandbox.runCommand("bash", [STARTUP_SCRIPT]);
  const readiness = await probeGatewayReady(sandbox, 80);
  const gatewayReadyMs = Date.now() - gwStart;

  if (!readiness.ready) {
    const diag = await collectDiagnostics(sandbox);
    log(`    ❌ gateway not ready after wake. log: ${diag.log}`);
    return { cycle, mode, phase: "wake", error: "gateway not ready after wake", restoreMs };
  }

  const totalMs = Date.now() - t0;
  log(`    gateway ready in ${gatewayReadyMs}ms (${readiness.attempts} probes), total: ${totalMs}ms`);

  // Re-snapshot for next cycle
  const snapStart = Date.now();
  const snap = await sandbox.snapshot();
  const reSnapshotMs = Date.now() - snapStart;

  return {
    cycle,
    mode,
    phase: "wake",
    restoreMs,
    gatewayReadyMs,
    totalMs,
    reSnapshotMs,
    nextSnapshotId: snap.snapshotId,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("bench-bundle-bootstrap");
  log(`  package:      ${PACKAGE_SPEC}`);
  log(`  bundle:       ${BUNDLE_PATH}`);
  log(`  cycles:       ${CYCLES}`);
  log(`  wake-cycles:  ${WAKE_CYCLES}`);
  log(`  vcpus:        ${VCPUS}`);

  if (!SKIP_BUNDLE) {
    try {
      const st = statSync(BUNDLE_PATH);
      log(`  bundle size:  ${(st.size / 1024 / 1024).toFixed(1)} MB`);
    } catch {
      log(`\n❌ Bundle not found at ${BUNDLE_PATH}`);
      log(`   Build it: cd ~/dev/openclaw && pnpm build && pnpm build:vercel-runtime-binary --skip-build`);
      process.exit(2);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    vcpus: VCPUS,
    bootstrapCycles: CYCLES,
    wakeCycles: WAKE_CYCLES,
  };

  // ---- Baseline bootstrap ----
  const baselineBootstrap = [];
  const baselineWake = [];

  if (!SKIP_BASELINE) {
    log("\n========== BASELINE BOOTSTRAP (npm install + gateway) ==========");
    for (let i = 1; i <= CYCLES; i++) {
      try {
        baselineBootstrap.push(await benchBaselineFull(i));
      } catch (err) {
        log(`    ❌ baseline cycle ${i}: ${err.message}`);
        baselineBootstrap.push({ cycle: i, mode: "baseline", error: err.message });
      }
    }

    // Wake from last successful snapshot
    if (!SKIP_WAKE) {
      const lastOk = [...baselineBootstrap].reverse().find((s) => s.snapshotId);
      if (lastOk) {
        log("\n========== BASELINE WAKE (snapshot restore + gateway) ==========");
        let snapId = lastOk.snapshotId;
        for (let i = 1; i <= WAKE_CYCLES; i++) {
          try {
            const result = await benchWake(snapId, "baseline", i);
            baselineWake.push(result);
            if (result.nextSnapshotId) snapId = result.nextSnapshotId;
          } catch (err) {
            log(`    ❌ baseline wake ${i}: ${err.message}`);
            baselineWake.push({ cycle: i, mode: "baseline", phase: "wake", error: err.message });
          }
        }
      } else {
        log("\n  ⚠ no baseline snapshot available, skipping wake benchmark");
      }
    }
  }

  // ---- Bundle bootstrap ----
  const bundleBootstrap = [];
  const bundleWake = [];

  if (!SKIP_BUNDLE) {
    log("\n========== BUNDLE BOOTSTRAP (upload + gateway) ==========");
    for (let i = 1; i <= CYCLES; i++) {
      try {
        bundleBootstrap.push(await benchBundleFull(i));
      } catch (err) {
        log(`    ❌ bundle cycle ${i}: ${err.message}`);
        bundleBootstrap.push({ cycle: i, mode: "bundle", error: err.message });
      }
    }

    if (!SKIP_WAKE) {
      const lastOk = [...bundleBootstrap].reverse().find((s) => s.snapshotId);
      if (lastOk) {
        log("\n========== BUNDLE WAKE (snapshot restore + gateway) ==========");
        let snapId = lastOk.snapshotId;
        for (let i = 1; i <= WAKE_CYCLES; i++) {
          try {
            const result = await benchWake(snapId, "bundle", i);
            bundleWake.push(result);
            if (result.nextSnapshotId) snapId = result.nextSnapshotId;
          } catch (err) {
            log(`    ❌ bundle wake ${i}: ${err.message}`);
            bundleWake.push({ cycle: i, mode: "bundle", phase: "wake", error: err.message });
          }
        }
      } else {
        log("\n  ⚠ no bundle snapshot available, skipping wake benchmark");
      }
    }
  }

  // ---- Build report ----
  const okBaselineBoot = baselineBootstrap.filter((s) => !s.error);
  if (okBaselineBoot.length > 0) {
    report.baselineBootstrap = {
      samples: baselineBootstrap,
      summary: {
        createMs: summarize(okBaselineBoot.map((s) => s.createMs)),
        installMs: summarize(okBaselineBoot.map((s) => s.installMs)),
        gatewayReadyMs: summarize(okBaselineBoot.map((s) => s.gatewayReadyMs)),
        bootstrapMs: summarize(okBaselineBoot.map((s) => s.bootstrapMs)),
        snapshotMs: summarize(okBaselineBoot.map((s) => s.snapshotMs)),
      },
    };
  }

  const okBaselineWake = baselineWake.filter((s) => !s.error);
  if (okBaselineWake.length > 0) {
    report.baselineWake = {
      samples: baselineWake,
      summary: {
        restoreMs: summarize(okBaselineWake.map((s) => s.restoreMs)),
        gatewayReadyMs: summarize(okBaselineWake.map((s) => s.gatewayReadyMs)),
        totalMs: summarize(okBaselineWake.map((s) => s.totalMs)),
      },
    };
  }

  const okBundleBoot = bundleBootstrap.filter((s) => !s.error);
  if (okBundleBoot.length > 0) {
    report.bundleBootstrap = {
      samples: bundleBootstrap,
      summary: {
        createMs: summarize(okBundleBoot.map((s) => s.createMs)),
        uploadMs: summarize(okBundleBoot.map((s) => s.uploadMs)),
        gatewayReadyMs: summarize(okBundleBoot.map((s) => s.gatewayReadyMs)),
        bootstrapMs: summarize(okBundleBoot.map((s) => s.bootstrapMs)),
        snapshotMs: summarize(okBundleBoot.map((s) => s.snapshotMs)),
      },
    };
  }

  const okBundleWake = bundleWake.filter((s) => !s.error);
  if (okBundleWake.length > 0) {
    report.bundleWake = {
      samples: bundleWake,
      summary: {
        restoreMs: summarize(okBundleWake.map((s) => s.restoreMs)),
        gatewayReadyMs: summarize(okBundleWake.map((s) => s.gatewayReadyMs)),
        totalMs: summarize(okBundleWake.map((s) => s.totalMs)),
      },
    };
  }

  // ---- Print comparison ----
  log("\n========== COMPARISON ==========");

  if (report.baselineBootstrap?.summary && report.bundleBootstrap?.summary) {
    const bb = report.baselineBootstrap.summary.bootstrapMs;
    const bu = report.bundleBootstrap.summary.bootstrapMs;
    log(`  BOOTSTRAP`);
    log(`    baseline  p50=${bb.p50}ms  avg=${bb.avg}ms`);
    log(`    bundle    p50=${bu.p50}ms  avg=${bu.avg}ms`);
    log(`    speedup:  ${(bb.p50 / bu.p50).toFixed(1)}x`);
  }

  if (report.baselineWake?.summary && report.bundleWake?.summary) {
    const bw = report.baselineWake.summary.totalMs;
    const buw = report.bundleWake.summary.totalMs;
    log(`\n  WAKE FROM SLEEP`);
    log(`    baseline  p50=${bw.p50}ms  avg=${bw.avg}ms`);
    log(`    bundle    p50=${buw.p50}ms  avg=${buw.avg}ms`);
    if (buw.p50 > 0) {
      const ratio = bw.p50 / buw.p50;
      log(`    ratio:    ${ratio.toFixed(2)}x ${ratio >= 1 ? "(bundle faster)" : "(bundle SLOWER)"}`);
    }

    log(`\n  WAKE BREAKDOWN`);
    log(`    baseline restore=${report.baselineWake.summary.restoreMs.p50}ms  gw=${report.baselineWake.summary.gatewayReadyMs.p50}ms`);
    log(`    bundle   restore=${report.bundleWake.summary.restoreMs.p50}ms  gw=${report.bundleWake.summary.gatewayReadyMs.p50}ms`);
  }

  log("\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
