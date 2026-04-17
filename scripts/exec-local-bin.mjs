#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const [, , binName, ...args] = process.argv;

if (!binName) {
  console.error("Usage: node scripts/exec-local-bin.mjs <bin> [...args]");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(rootDir, "node_modules", ".bin");
const executable =
  process.platform === "win32"
    ? path.join(binDir, `${binName}.cmd`)
    : path.join(binDir, binName);

if (!existsSync(executable)) {
  console.error(`Local binary not found: ${executable}`);
  console.error("Run pnpm install before invoking this wrapper.");
  process.exit(127);
}

const child = spawn(executable, args, {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  },
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
