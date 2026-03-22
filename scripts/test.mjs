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

const testFiles = findTestFiles(srcDir).sort();

if (testFiles.length === 0) {
  console.error(`No test files found under ${srcDir}`);
  process.exit(1);
}

const args = ["--import", "tsx", "--test"];
if (watchMode) {
  args.push("--watch");
}
args.push(...testFiles);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" },
});

process.exit(result.status ?? 1);
