#!/usr/bin/env node
/**
 * Machine-readable audit: detect dead channel-queue surface left over
 * after the migration to Workflow DevKit.
 *
 * Exit 0 + JSON { schemaVersion: 2, ok: true, violations: [], allowedExceptions: [] }
 * when clean.
 * Exit 1 + JSON { schemaVersion: 2, ok: false, violations: [...], allowedExceptions: [...] }
 * when drift detected.
 *
 * Launch-verify queue references (/api/queues/launch-verify,
 * src/server/launch-verify/queue-probe.ts) are intentionally allowlisted.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SELF_REL = "scripts/audit-dead-channel-queue-surface.mjs";

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

const TARGETS = [
  "src",
  "scripts",
  "README.md",
  "CLAUDE.md",
  ".env.example",
  "package.json",
  "vercel.json",
];

/** Banned tokens — each hit outside exclusion lists is a violation. */
const BANNED = [
  { id: "queueDepth", pattern: /\bqueueDepth\b/g },
  { id: "channel-store-drain", pattern: /\bchannel\.store\.drain\b/g },
  { id: "preflight-drain-recovery", pattern: /\bdrain-recovery\b/g },
  {
    id: "channel-queue-routes",
    pattern: /\/api\/queues\/channels\/(?:slack|telegram|discord)\b/g,
  },
  { id: "channel-queue-health-card", pattern: /\bChannelQueueHealthCard\b/g },
  { id: "vercel-queue-dependency", pattern: /@vercel\/queue\b/g },
  {
    id: "stale-channel-transport-docs",
    pattern:
      /Channel delivery uses Vercel Queues as the primary durable transport\./g,
  },
];

/** Files that legitimately reference banned tokens (meta-guards, this script). */
const EXCLUDED_FILES = new Set([SELF_REL]);

/**
 * Launch-verify allowlist — files that are part of the intentional
 * launch-verify queue surface. Matches in these files are reported
 * as allowed exceptions, not violations.
 */
const LAUNCH_VERIFY_ALLOWLIST = new Set([
  "src/app/api/queues/launch-verify/route.ts::vercel-queue-dependency",
  "src/server/launch-verify/queue-probe.ts::vercel-queue-dependency",
  "src/app/api/admin/launch-verify/route.test.ts::vercel-queue-dependency",
  "scripts/check-queue-consumers.mjs::vercel-queue-dependency",
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

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function collectHits(filePath, text) {
  const hits = [];
  for (const rule of BANNED) {
    // Reset lastIndex for each file since patterns use /g
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const at = match.index ?? 0;
      const { line, column } = lineAndColumn(text, at);
      hits.push({
        id: rule.id,
        file: filePath,
        line,
        column,
        match: match[0],
      });
    }
  }
  return hits;
}

// --- main ---

const files = Array.from(new Set(TARGETS.flatMap(collectFiles))).sort();

const violations = [];
const allowedExceptions = [];

for (const file of files) {
  if (EXCLUDED_FILES.has(file)) continue;
  const hits = collectHits(file, readFileSync(join(ROOT, file), "utf8"));
  for (const hit of hits) {
    const allowlistKey = `${file}::${hit.id}`;
    if (LAUNCH_VERIFY_ALLOWLIST.has(allowlistKey)) {
      allowedExceptions.push({ ...hit, reason: "launch-verify-allowlist" });
    } else {
      violations.push(hit);
    }
  }
}

const report = {
  schemaVersion: 2,
  ok: violations.length === 0,
  violations,
  allowedExceptions,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
