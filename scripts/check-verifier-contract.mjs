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

// Package manager must be pnpm
if (
  typeof pkg.packageManager !== "string" ||
  !pkg.packageManager.startsWith("pnpm@")
) {
  failures.push('package.json packageManager must start with "pnpm@"');
}

// Lock file checks
if (!existsSync(pnpmLockPath)) {
  failures.push("pnpm-lock.yaml is missing");
}

if (existsSync(packageLockPath)) {
  failures.push("package-lock.json must be removed");
}

if (existsSync(pnpmWorkspacePath)) {
  failures.push("pnpm-workspace.yaml must be removed (this is not a workspace)");
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
  { pattern: /\bnpm(?:\s+run)?\s+(?:test|lint|typecheck|build)\b/g, label: "npm run <step>" },
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
// The deployment contract warns (not fails) on Vercel when the spec is
// unset or unpinned. The runtime falls back to a pinned known-good version
// (currently openclaw@2026.4.12). Docs must not contradict either of these facts.
// ---------------------------------------------------------------------------

const policyDocFiles = ["README.md", "CLAUDE.md", "CONTRIBUTING.md"];
const policyContradictions = [
  {
    // Catches "fails (not warns)", "fail (not warn)", etc.
    pattern: /\bfail[s ]?\s*\(not\s+(?:a\s+)?warn(?:ing)?\)/gi,
    label:
      'claims OPENCLAW_PACKAGE_SPEC contract status is fail (not warn) on Vercel — it is warn-only',
  },
  {
    // Catches "OPENCLAW_PACKAGE_SPEC … hard fail" in the same sentence.
    pattern: /\bOPENCLAW_PACKAGE_SPEC\b[^.\n]*\b(?:hard\s+)?fail/gi,
    label:
      'claims OPENCLAW_PACKAGE_SPEC is a deployment blocker on Vercel — it is warn-only',
  },
  {
    pattern: /\bruntime\s+refuses\s+to\s+install\b/gi,
    label:
      'claims runtime refuses to install when OPENCLAW_PACKAGE_SPEC is unpinned — runtime falls back to a pinned known-good version',
  },
  // NOTE: "api-key" is now a valid AI Gateway auth mode alongside "oidc"
  // and "unavailable". The previous guards against stale "api-key"
  // references have been removed.
  {
    // The preflight route performs runtime auth detection, not just config.
    // "config-only" misleads callers into thinking the check is static.
    pattern: /preflight.*AI Gateway auth \(config-only\)/gi,
    label:
      'describes preflight AI Gateway check as "config-only" — it performs runtime auth detection',
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
  "docs/environment-variables.md": path.join(rootDir, "docs", "environment-variables.md"),
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

// ---------------------------------------------------------------------------
// Key wording checks — ensure docs stay aligned with runtime behavior on
// Telegram bypass, AI Gateway fallback, OPENCLAW_PACKAGE_SPEC warn-only, and
// the docs/env contract guard itself.
// ---------------------------------------------------------------------------

const wordingRequirements = [
  {
    snippet: "All channel webhook URLs",
    label: "Telegram bypass behavior",
    files: ["docs/deployment-protection.md", "CONTRIBUTING.md"],
  },
  {
    snippet: "deployment contract **warns** — it does not fail",
    label: "OPENCLAW_PACKAGE_SPEC warn-only policy",
    files: ["CLAUDE.md"],
  },
  {
    snippet: "warningChannelIds` is deprecated",
    label: "launch verification deprecated diagnostics field",
    files: ["docs/api-reference.md", "CONTRIBUTING.md", "CLAUDE.md"],
  },
  {
    snippet: "verify.step.start",
    label: "verify.mjs event contract",
    files: ["docs/api-reference.md", "CONTRIBUTING.md"],
  },
  {
    snippet: "`0` = pass",
    label: "check-deploy-readiness exit codes",
    files: ["docs/api-reference.md", "CONTRIBUTING.md"],
  },
];

for (const { snippet, label, files } of wordingRequirements) {
  for (const relPath of files) {
    const absPath = path.join(rootDir, relPath);
    if (!existsSync(absPath)) {
      failures.push(`${relPath}: missing file (needed for wording check: ${label})`);
      continue;
    }
    const text = readFileSync(absPath, "utf8");
    if (!text.includes(snippet)) {
      failures.push(`${relPath}: missing required wording "${snippet}" (${label})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Operator route documentation checks — ensure CONTRIBUTING.md documents
// every operator-facing route that CLAUDE.md describes.
// ---------------------------------------------------------------------------

const routeDocRequirements = [
  {
    file: "CONTRIBUTING.md",
    routes: [
      "/api/admin/preflight",
      "/api/admin/launch-verify",
      "/api/queues/launch-verify",
      "/api/admin/ensure",
      "/api/admin/stop",
      "/api/admin/snapshot",
      "/api/admin/snapshots/delete",
      "/api/admin/channel-secrets",
      "/api/cron/watchdog",
      "/api/admin/watchdog",
    ],
  },
];

for (const { file, routes } of routeDocRequirements) {
  const absPath = path.join(rootDir, file);
  if (!existsSync(absPath)) {
    failures.push(`${file}: missing file (needed for route docs check)`);
    continue;
  }

  const text = readFileSync(absPath, "utf8");
  for (const route of routes) {
    if (!text.includes(`\`${route}\``)) {
      failures.push(`${file}: missing operator route "${route}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Docs surface checks — ensure verification behavior nuances are documented
// in README.md, CONTRIBUTING.md, and the testing skill doc.
// ---------------------------------------------------------------------------

const docsSurfaceRequirements = [
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md"],
    snippet: "queue-consumers",
    label: "verify.mjs queue-consumers pre-step",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md"],
    snippet: "bootstrapExposure",
    label: "check-deploy-readiness bootstrap exposure output",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md"],
    snippet: "--protection-bypass",
    label: "check-deploy-readiness protection bypass flag",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md", "CLAUDE.md"],
    snippet: "`GET /api/admin/launch-verify` returns",
    label: "launch-verify GET readiness surface",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md", "CLAUDE.md"],
    snippet: "channelReadiness",
    label: "launch-verify extended response payload",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md", "CLAUDE.md"],
    snippet: "ChannelReadiness",
    label: "launch-verify readiness type docs",
    optional: false,
  },
  {
    files: ["docs/api-reference.md", "CONTRIBUTING.md", "CLAUDE.md"],
    snippet: "terminal `result` event carries the same extended payload",
    label: "launch-verify NDJSON result payload docs",
    optional: false,
  },
  {
    files: [".claude/skills/vercel-openclaw-testing/SKILL.md"],
    snippet: "node scripts/verify.mjs",
    label: "testing skill canonical verify entrypoint",
    optional: true,
  },
  {
    files: [".claude/skills/vercel-openclaw-testing/SKILL.md"],
    snippet: "check-deploy-readiness.mjs",
    label: "testing skill remote readiness entrypoint",
    optional: true,
  },
];

for (const { files, snippet, label, optional } of docsSurfaceRequirements) {
  for (const relPath of files) {
    const absPath = path.join(rootDir, relPath);
    if (!existsSync(absPath)) {
      if (!optional) {
        failures.push(`${relPath}: missing file (needed for docs surface check: ${label})`);
      }
      continue;
    }

    const text = readFileSync(absPath, "utf8");
    if (!text.includes(snippet)) {
      failures.push(`${relPath}: missing required wording "${snippet}" (${label})`);
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
