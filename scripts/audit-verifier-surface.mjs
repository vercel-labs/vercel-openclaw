#!/usr/bin/env node
/**
 * Machine-readable self-audit: verify the repo signals pnpm-first
 * (host migrated from npm to pnpm in PR #7) and contains no stale
 * npm/tsx references in discovery surfaces.
 *
 * Exit 0 + JSON { ok: true, ... } when clean.
 * Exit 1 + JSON { ok: false, findings: [...] } when drift detected.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

const ROOT = process.cwd();

const CANDIDATE_PATHS = [
  "package.json",
  "README.md",
  "CLAUDE.md",
  "Makefile",
  ".github/workflows",
  "scripts",
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
  ".sh",
]);

function collectFiles(pathName) {
  const absolutePath = join(ROOT, pathName);
  if (!existsSync(absolutePath)) return [];

  const stat = lstatSync(absolutePath);
  if (stat.isFile()) return [pathName];
  if (!stat.isDirectory()) return [];

  const results = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      results.push(...collectFiles(join(pathName, entry.name)));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      results.push(join(pathName, entry.name));
    }
  }
  return results;
}

function scanFile(text, file) {
  const findings = [];
  // Sandbox bootstrap legitimately uses npm inside the Vercel Sandbox
  // (Plan 4b — migrating the sandbox to pnpm is a separate effort).
  const isSandboxBootstrap = file.startsWith("src/server/openclaw/");
  const patterns = [
    // Flag bare "npm" commands in host tooling — the host repo is pnpm-first.
    // Allow `npm` inside the sandbox bootstrap until Plan 4b lands.
    ...(isSandboxBootstrap
      ? []
      : [{ label: "npm", regex: /\bnpm\s+(install|ci|run|test|exec)\b/ }]),
    { label: "npx tsx", regex: /npx\s+tsx/ },
    { label: "tsx --test", regex: /tsx\s+--test/, skip: /--import\s+tsx\s+--test/ },
  ];

  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const pattern of patterns) {
      if (pattern.regex.test(lineText) && !(pattern.skip && pattern.skip.test(lineText))) {
        findings.push({
          file,
          pattern: pattern.label,
          line: index + 1,
          text: lineText.trim(),
        });
      }
    }
  });

  return findings;
}

// Exclude meta-guard scripts that legitimately reference pnpm/tsx patterns,
// plus scripts that benchmark/emulate sandbox bootstrap (sandbox still uses
// npm until Plan 4b lands).
const EXCLUDED_FILES = new Set([
  "scripts/audit-verifier-surface.mjs",
  "scripts/verify-package-manager.mjs",
  "scripts/check-verifier-contract.mjs",
  "scripts/test-self-heal.ts",
  "scripts/vendor-openclaw-runtime-artifact.mjs",
  "scripts/bench-sandbox-direct.mjs",
  "scripts/bench-bundle-bootstrap.mjs",
  "scripts/bench-sdk-snapshot.mjs",
]);

// Exclude directories whose contents legitimately shell out to npm inside
// the sandbox. Plan 4b will migrate these together.
const EXCLUDED_DIR_PREFIXES = [
  "scripts/experiments/",
];

const packageJsonPath = join(ROOT, "package.json");
let packageManager = null;

if (existsSync(packageJsonPath)) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  packageManager =
    typeof pkg.packageManager === "string" ? pkg.packageManager : null;
}

const files = Array.from(new Set(CANDIDATE_PATHS.flatMap(collectFiles))).sort();

const findings = files
  .flatMap((file) => scanFile(readFileSync(join(ROOT, file), "utf8"), file))
  .filter(
    (f) =>
      !EXCLUDED_FILES.has(f.file) &&
      !EXCLUDED_DIR_PREFIXES.some((prefix) => f.file.startsWith(prefix)),
  );

const result = {
  ok:
    typeof packageManager === "string" &&
    packageManager.startsWith("pnpm@") &&
    existsSync(join(ROOT, "pnpm-lock.yaml")) &&
    !existsSync(join(ROOT, "package-lock.json")) &&
    findings.length === 0,
  packageManager,
  hasPackageLock: existsSync(join(ROOT, "package-lock.json")),
  hasPnpmLock: existsSync(join(ROOT, "pnpm-lock.yaml")),
  findings,
  expectedVerifyCommand: "node scripts/verify.mjs",
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
