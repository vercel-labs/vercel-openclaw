#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJsonPath = path.join(rootDir, "package.json");
const packageLockPath = path.join(rootDir, "package-lock.json");
const pnpmLockPath = path.join(rootDir, "pnpm-lock.yaml");
const pnpmWorkspacePath = path.join(rootDir, "pnpm-workspace.yaml");
const makefilePath = path.join(rootDir, "Makefile");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const failures = [];

// Package manager must be npm
if (
  typeof pkg.packageManager !== "string" ||
  !pkg.packageManager.startsWith("npm@")
) {
  failures.push('package.json packageManager must start with "npm@"');
}

// Lock file checks
if (!existsSync(packageLockPath)) {
  failures.push("package-lock.json is missing");
}

if (existsSync(pnpmLockPath)) {
  failures.push("pnpm-lock.yaml must be removed");
}

if (existsSync(pnpmWorkspacePath)) {
  failures.push("pnpm-workspace.yaml must be removed");
}

// Script entrypoint checks
if (pkg.scripts?.test !== "node scripts/test.mjs") {
  failures.push('scripts.test must equal "node scripts/test.mjs"');
}

if (pkg.scripts?.verify !== "node scripts/verify.mjs") {
  failures.push('scripts.verify must equal "node scripts/verify.mjs"');
}

// Makefile must exist
if (!existsSync(makefilePath)) {
  failures.push("Makefile is missing");
}

// Documentation surface checks — ensure markdown files don't reference
// disallowed automation commands that would mislead external verifiers
const docFiles = [
  "README.md",
  "CLAUDE.md",
  ".claude/skills/vercel-openclaw-testing/SKILL.md",
];
const disallowedPatterns = [
  { pattern: /\bpnpm(?:\s+run)?\s+(?:test|lint|typecheck|build)\b/g, label: "pnpm run <step>" },
  { pattern: /\bnpx\s+tsx\b/g, label: "npx tsx" },
  { pattern: /\btsx\s+--test\b/g, label: "tsx --test" },
];

for (const relPath of docFiles) {
  const absPath = path.join(rootDir, relPath);
  if (!existsSync(absPath)) continue;

  const text = readFileSync(absPath, "utf8");
  for (const { pattern, label } of disallowedPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      failures.push(`${relPath}: contains disallowed automation hint "${label}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deployment contract env surface check
// Extract env names from deployment-contract.ts and verify they appear in docs.
// ---------------------------------------------------------------------------

const contractPath = path.join(rootDir, "src", "server", "deployment-contract.ts");
const contractSource = readFileSync(contractPath, "utf8");

// Match all `env: ["VAR_NAME"]` or `env: ["VAR_NAME", "OTHER"]` patterns
const envPattern = /env:\s*\[([^\]]+)\]/g;
const contractEnvNames = new Set();

let envMatch;
while ((envMatch = envPattern.exec(contractSource)) !== null) {
  const inner = envMatch[1];
  // Extract quoted strings
  const namePattern = /"([^"]+)"/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(inner)) !== null) {
    contractEnvNames.add(nameMatch[1]);
  }
}

if (contractEnvNames.size === 0) {
  failures.push("deployment-contract.ts: could not extract any env names from env: [...] arrays");
}

const envDocFiles = {
  "README.md": path.join(rootDir, "README.md"),
  "CLAUDE.md": path.join(rootDir, "CLAUDE.md"),
  ".env.example": path.join(rootDir, ".env.example"),
};

for (const envName of contractEnvNames) {
  for (const [label, filePath] of Object.entries(envDocFiles)) {
    if (!existsSync(filePath)) {
      failures.push(`${label}: file missing (needed for env surface check)`);
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    if (!content.includes(envName)) {
      failures.push(`${label}: missing deployment-contract env "${envName}"`);
    }
  }
}

const payload = {
  event: "verifier_contract.checked",
  ok: failures.length === 0,
  failures,
  contractEnvNames: [...contractEnvNames].sort(),
  packageManager: pkg.packageManager ?? null,
  hasPackageLock: existsSync(packageLockPath),
  hasPnpmLock: existsSync(pnpmLockPath),
  hasPnpmWorkspace: existsSync(pnpmWorkspacePath),
  hasMakefile: existsSync(makefilePath),
  scripts: {
    test: pkg.scripts?.test ?? null,
    verify: pkg.scripts?.verify ?? null,
  },
};

console.log(JSON.stringify(payload));

if (!payload.ok) {
  process.exit(1);
}
