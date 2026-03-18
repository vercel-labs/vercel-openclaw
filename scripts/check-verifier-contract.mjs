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
// OPENCLAW_PACKAGE_SPEC policy accuracy check
// The deployment contract hard-fails (not warns) on Vercel when the spec is
// unset or unpinned. The runtime still falls back to openclaw@latest with a
// warning log. Docs must not contradict either of these facts.
// ---------------------------------------------------------------------------

const policyDocFiles = ["README.md", "CLAUDE.md", "CONTRIBUTING.md"];
const policyContradictions = [
  {
    // Catches "emits a warn (not a hard fail)", "warns (not fails)", etc.
    // These phrases uniquely describe the OPENCLAW_PACKAGE_SPEC policy.
    pattern: /\bwarn[s ]?\s*\(not\s+(?:a\s+(?:hard\s+)?)?fail[s]?\)/gi,
    label: 'claims OPENCLAW_PACKAGE_SPEC contract status is warn (not fail) on Vercel — it is a hard fail',
  },
  {
    // Catches "warn (not a hard fail)"
    pattern: /\bwarn\b[^.]*\bnot\s+a\s+hard\s+fail\b/gi,
    label: 'claims OPENCLAW_PACKAGE_SPEC contract status is warn (not a hard fail) on Vercel — it is a hard fail',
  },
  {
    pattern: /\bruntime\s+refuses\s+to\s+install\b/gi,
    label: 'claims runtime refuses to install when OPENCLAW_PACKAGE_SPEC is unpinned — runtime falls back to openclaw@latest',
  },
  // NOTE: "api-key" is now a valid AI Gateway auth mode alongside "oidc"
  // and "unavailable". The previous guards against stale "api-key"
  // references have been removed.
  {
    // The preflight route probes OIDC at runtime, not just config.
    // "config-only" misleads callers into thinking the check is static.
    pattern: /preflight.*AI Gateway auth \(config-only\)/gi,
    label: 'describes preflight AI Gateway check as "config-only" — it probes OIDC at runtime',
  },
];

for (const relPath of policyDocFiles) {
  const absPath = path.join(rootDir, relPath);
  if (!existsSync(absPath)) continue;

  const text = readFileSync(absPath, "utf8");
  for (const { pattern, label } of policyContradictions) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      failures.push(`${relPath}: ${label}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deployment contract env surface check
// Extract env names from deployment-contract.ts and verify they appear in docs.
// ---------------------------------------------------------------------------

const contractPath = path.join(rootDir, "src", "server", "deployment-contract.ts");
const contractSource = readFileSync(contractPath, "utf8");

// Step 1: Build a map of const array declarations (e.g. `const FOO = ["A", "B"]`)
const constArrayPattern = /const\s+(\w+)\s*(?::\s*\w+(?:\[\])?\s*)?=\s*\[([^\]]+)\]/g;
const constArrays = new Map();
let constMatch;
while ((constMatch = constArrayPattern.exec(contractSource)) !== null) {
  const names = [];
  const namePattern = /"([^"]+)"/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(constMatch[2])) !== null) {
    names.push(nameMatch[1]);
  }
  if (names.length > 0) {
    constArrays.set(constMatch[1], names);
  }
}

// Step 2: Match inline `env: ["VAR"]` and referenced `env: CONST_NAME` patterns
const contractEnvNames = new Set();

// Inline arrays: env: ["VAR_NAME", "OTHER"]
const envInlinePattern = /env:\s*\[([^\]]+)\]/g;
let envMatch;
while ((envMatch = envInlinePattern.exec(contractSource)) !== null) {
  const namePattern = /"([^"]+)"/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(envMatch[1])) !== null) {
    contractEnvNames.add(nameMatch[1]);
  }
}

// Variable references: env: PUBLIC_ORIGIN_ENV
const envRefPattern = /env:\s*([A-Z_][A-Z_0-9]*)/g;
let refMatch;
while ((refMatch = envRefPattern.exec(contractSource)) !== null) {
  const resolved = constArrays.get(refMatch[1]);
  if (resolved) {
    for (const name of resolved) {
      contractEnvNames.add(name);
    }
  }
}

// Vercel system env vars are auto-set by the platform and do not belong in
// user-facing docs or .env.example. Exclude them from the doc surface check.
const VERCEL_SYSTEM_ENV = new Set([
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_URL",
]);

for (const name of VERCEL_SYSTEM_ENV) {
  contractEnvNames.delete(name);
}

if (contractEnvNames.size === 0) {
  failures.push("deployment-contract.ts: could not extract any env names from env: [...] arrays");
}

const envDocFiles = {
  "README.md": path.join(rootDir, "README.md"),
  "CLAUDE.md": path.join(rootDir, "CLAUDE.md"),
  "CONTRIBUTING.md": path.join(rootDir, "CONTRIBUTING.md"),
  ".env.example": path.join(rootDir, ".env.example"),
};

// Use word-boundary matching so that e.g. "BASE_DOMAIN" is not falsely found
// inside "NEXT_PUBLIC_BASE_DOMAIN".
function docContainsEnvName(content, envName) {
  const pattern = new RegExp(`(?<![A-Z_])${envName}(?![A-Z_])`);
  return pattern.test(content);
}

for (const envName of contractEnvNames) {
  for (const [label, filePath] of Object.entries(envDocFiles)) {
    if (!existsSync(filePath)) {
      failures.push(`${label}: file missing (needed for env surface check)`);
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    if (!docContainsEnvName(content, envName)) {
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
