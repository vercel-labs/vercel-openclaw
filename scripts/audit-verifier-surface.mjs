#!/usr/bin/env node
/**
 * Machine-readable self-audit: verify the repo signals npm-first
 * and contains no stale pnpm/tsx references in discovery surfaces.
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
  ".claude/skills",
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
  const patterns = [
    { label: "pnpm", regex: /\bpnpm\b/ },
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

// Exclude meta-guard scripts that legitimately reference pnpm/tsx patterns
const EXCLUDED_FILES = new Set([
  "scripts/audit-verifier-surface.mjs",
  "scripts/verify-package-manager.mjs",
  "scripts/check-verifier-contract.mjs",
  "scripts/test-self-heal.ts",
  "scripts/vendor-openclaw-runtime-artifact.mjs",
]);

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
  .filter((f) => !EXCLUDED_FILES.has(f.file));

const result = {
  ok:
    typeof packageManager === "string" &&
    packageManager.startsWith("npm@") &&
    existsSync(join(ROOT, "package-lock.json")) &&
    !existsSync(join(ROOT, "pnpm-lock.yaml")) &&
    findings.length === 0,
  packageManager,
  hasPackageLock: existsSync(join(ROOT, "package-lock.json")),
  hasPnpmLock: existsSync(join(ROOT, "pnpm-lock.yaml")),
  findings,
  expectedVerifyCommand: "node scripts/verify.mjs",
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
