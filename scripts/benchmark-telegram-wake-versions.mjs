#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    versions: { type: "string" },
    timeout: { type: "string", default: "180" },
    port: { type: "string", default: "3005" },
    "request-timeout": { type: "string", default: "30" },
    "artifacts-dir": { type: "string" },
    "continue-on-fail": { type: "boolean", default: true },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stderr.write(`benchmark-telegram-wake-versions

USAGE
  node scripts/benchmark-telegram-wake-versions.mjs [options]

OPTIONS
  --versions         Comma-separated npm versions, e.g. 2026.3.28,2026.3.31,2026.4.11
  --timeout          Per-run timeout in seconds (default: 180)
  --port             Local Next.js port (default: 3005)
  --request-timeout  Per-request timeout in seconds (default: 30)
  --artifacts-dir    Root directory for per-version artifacts
  --continue-on-fail Keep sweeping after a failed version (default: true)
  --help             Show this help
`);
  process.exit(0);
}

const versions = (
  values.versions?.split(",").map((v) => v.trim()).filter(Boolean) ??
  positionals.map((v) => v.trim()).filter(Boolean)
);

if (versions.length === 0) {
  process.stderr.write("error: provide versions via --versions or positionals\n");
  process.exit(2);
}

const repoRoot = process.cwd();
const artifactsRoot = values["artifacts-dir"]?.trim()
  ? path.resolve(values["artifacts-dir"])
  : path.join(repoRoot, ".artifacts", "telegram-wake-version-sweep", new Date().toISOString().replace(/[:.]/g, "-"));

await fs.mkdir(artifactsRoot, { recursive: true });

function log(message) {
  process.stderr.write(`[benchmark-telegram-wake-versions] ${message}\n`);
}

async function runOne(version, index) {
  const packageSpec = `openclaw@${version}`;
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  const versionArtifacts = path.join(artifactsRoot, `${String(index + 1).padStart(2, "0")}-${safeVersion}`);

  log(`starting ${packageSpec}`);

  const child = spawn(
    "node",
    [
      path.join(repoRoot, "scripts/test-telegram-wake-local.mjs"),
      "--port",
      values.port,
      "--timeout",
      values.timeout,
      "--request-timeout",
      values["request-timeout"],
      "--openclaw-package-spec",
      packageSpec,
      "--artifacts-dir",
      versionArtifacts,
      "--json-only",
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  let summary = null;
  try {
    summary = JSON.parse(stdout.trim().split(/\n/).filter(Boolean).at(-1) ?? "null");
  } catch {
    summary = null;
  }

  return {
    version,
    packageSpec,
    exitCode,
    summary,
    stderrTail: stderr.split(/\r?\n/).slice(-80),
    artifactsDir: versionArtifacts,
  };
}

const results = [];
for (let i = 0; i < versions.length; i += 1) {
  const result = await runOne(versions[i], i);
  results.push(result);
  const passed = result.summary?.passed === true;
  log(`${result.packageSpec} => ${passed ? "PASS" : "FAIL"} (artifacts: ${result.artifactsDir})`);

  if (!passed && !values["continue-on-fail"]) {
    break;
  }
}

const output = {
  schemaVersion: 1,
  type: "telegram-wake-version-sweep",
  generatedAt: new Date().toISOString(),
  artifactsRoot,
  results: results.map((result) => ({
    version: result.version,
    packageSpec: result.packageSpec,
    exitCode: result.exitCode,
    passed: result.summary?.passed === true,
    requestId: result.summary?.requestId ?? null,
    wakeError: result.summary?.wakeError ?? null,
    workflowOutcome: result.summary?.wake?.workflowOutcome?.outcome ?? null,
    artifactsDir: result.artifactsDir,
  })),
};

await fs.writeFile(
  path.join(artifactsRoot, "summary.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
