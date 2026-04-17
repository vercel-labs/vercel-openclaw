#!/usr/bin/env node
/**
 * Regression guard: fail if npm signals reappear on the host side of the repo.
 *
 * The sandbox bootstrap (src/server/openclaw/**) still uses npm to install
 * openclaw inside the Vercel Sandbox; that migration is tracked separately.
 * This guard only enforces the host-side package-manager contract:
 *
 *   1. No package-lock.json at repo root (pnpm-lock.yaml is the source of truth)
 *   2. pnpm-lock.yaml exists at repo root
 *   3. package.json#packageManager starts with "pnpm@"
 *   4. No scripts in package.json reference `npm (install|ci|run|test|exec)`
 *   5. No `npm (install|ci|run|test|exec)` references in the scanned
 *      host-side text files (docs, CI workflows, Makefile). The sandbox
 *      bootstrap paths under src/server/openclaw/** are intentionally
 *      excluded until Plan 4b migrates them.
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const disallowedRootFiles = ["package-lock.json"];
const requiredRootFiles = ["pnpm-lock.yaml"];

// Host-side surfaces we want to be fully pnpm. The sandbox bootstrap paths
// under src/server/openclaw/** are deliberately excluded from this scan
// until Plan 4b migrates the in-sandbox install.
const scanRoots = [
  "package.json",
  "vercel.json",
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".github/workflows",
  "Makefile",
];

const textExtensions = new Set([
  ".md",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".sh",
  ".yml",
  ".yaml",
]);

const skipDirs = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  ".turbo",
]);

// Matches automation calls to npm. We intentionally allow prose mentions of
// "npm" as a word (e.g. "the npm registry") by anchoring to the known
// subcommands we care about.
const NPM_AUTOMATION_PATTERN =
  /\bnpm\s+(install|ci|run|test|exec|init|update|uninstall|add)\b/;

function collectFiles(absolutePath, out) {
  if (!fs.existsSync(absolutePath)) return;
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    out.push(absolutePath);
    return;
  }
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    collectFiles(path.join(absolutePath, entry.name), out);
  }
}

function shouldScan(absolutePath) {
  const base = path.basename(absolutePath);
  if (base === "pnpm-lock.yaml") return false;
  if (base === "verify-package-manager.mjs") return false;
  if (base === "audit-verifier-surface.mjs") return false;
  if (base === "check-verifier-contract.mjs") return false;
  return (
    textExtensions.has(path.extname(base)) ||
    base === "Dockerfile" ||
    base === "Makefile"
  );
}

// ── 1. Disallowed root files ──────────────────────────────────────────
const rootFileOffenders = disallowedRootFiles.filter((name) =>
  fs.existsSync(path.join(repoRoot, name)),
);

// ── 2. Required root files ────────────────────────────────────────────
const missingRootFiles = requiredRootFiles.filter(
  (name) => !fs.existsSync(path.join(repoRoot, name)),
);

// ── 3. package.json checks ────────────────────────────────────────────
const pkgPath = path.join(repoRoot, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error("package-manager verification failed");
  console.error("- package.json is missing");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const packageJsonIssues = [];

if (
  typeof pkg.packageManager !== "string" ||
  !pkg.packageManager.startsWith("pnpm@")
) {
  packageJsonIssues.push(
    `package.json: packageManager must start with pnpm@ (received ${JSON.stringify(pkg.packageManager ?? null)})`,
  );
}

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  if (typeof command === "string" && NPM_AUTOMATION_PATTERN.test(command)) {
    packageJsonIssues.push(
      `package.json:scripts.${name} invokes npm -> ${command}`,
    );
  }
}

// ── 4. Text-file scan ─────────────────────────────────────────────────
const filesToScan = [];
for (const relPath of scanRoots) {
  collectFiles(path.join(repoRoot, relPath), filesToScan);
}

const textOffenders = [];
for (const absolutePath of filesToScan) {
  if (!shouldScan(absolutePath)) continue;
  const relativePath = path.relative(repoRoot, absolutePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  if (NPM_AUTOMATION_PATTERN.test(text)) {
    textOffenders.push(relativePath);
  }
}

// ── Report ────────────────────────────────────────────────────────────
if (
  rootFileOffenders.length ||
  missingRootFiles.length ||
  packageJsonIssues.length ||
  textOffenders.length
) {
  console.error("package-manager verification failed");

  if (rootFileOffenders.length) {
    console.error("\nDisallowed root files:");
    for (const file of rootFileOffenders) console.error(`  - ${file}`);
  }
  if (missingRootFiles.length) {
    console.error("\nMissing required root files:");
    for (const file of missingRootFiles) console.error(`  - ${file}`);
  }
  if (packageJsonIssues.length) {
    console.error("\npackage.json issues:");
    for (const issue of packageJsonIssues) console.error(`  - ${issue}`);
  }
  if (textOffenders.length) {
    console.error("\nRemaining npm automation references (host side):");
    for (const file of textOffenders) console.error(`  - ${file}`);
  }

  process.exit(1);
}

console.log("package-manager verification passed");
