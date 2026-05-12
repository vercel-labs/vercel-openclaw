#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const watchMode = process.argv.includes("--watch");
const supportedSuffixes = [
  ".test.ts",
  ".test.tsx",
  ".test.mts",
  ".test.cts",
];

// Optional file arguments — anything that isn't a flag is treated as an
// explicit test file path. Lets focused scripts like `test:preflight` route
// through this wrapper (and pick up NODE_ENV=test below) instead of bypassing
// it with a raw `node --test`.
const fileArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

function findTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findTestFiles(fullPath));
      continue;
    }

    if (
      entry.isFile() &&
      supportedSuffixes.some((suffix) => entry.name.endsWith(suffix))
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

const testFiles =
  fileArgs.length > 0
    ? fileArgs.map((f) => path.resolve(rootDir, f))
    : findTestFiles(srcDir).sort();

if (testFiles.length === 0) {
  console.error(`No test files found under ${srcDir}`);
  process.exit(1);
}

const args = ["--import", "tsx", "--test", "--test-concurrency=1"];
if (watchMode) {
  args.push("--watch");
}
args.push(...testFiles);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" },
});

process.exit(result.status ?? 1);
