#!/usr/bin/env node
/**
 * Generate or validate a manifest of protected admin/firewall/debug route handlers.
 *
 * Usage:
 *   node scripts/generate-protected-route-manifest.mjs
 *   node scripts/generate-protected-route-manifest.mjs --check
 *   node scripts/generate-protected-route-manifest.mjs --help
 *
 * Exit codes:
 *   0 = no policy violations; manifest written or already current
 *   1 = one or more policy violations detected
 *   2 = --check mode only: checked-in manifest is stale
 *
 * Output:
 *   - Writes src/app/api/auth/protected-route-manifest.json when not in --check mode
 *   - Prints a single JSON summary line to stdout
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const PROJECT_ROOT = process.cwd();
const API_ROOT = join(PROJECT_ROOT, "src", "app", "api");
const MANIFEST_PATH = join(
  API_ROOT,
  "auth",
  "protected-route-manifest.json",
);

const ROUTE_ROOTS = [
  { kind: "admin", root: join(API_ROOT, "admin") },
  { kind: "firewall", root: join(API_ROOT, "firewall") },
  { kind: "debug", root: join(API_ROOT, "debug") },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const AUTH_TOKENS = [
  "requireJsonRouteAuth(",
  "requireMutationAuth(",
  "requireAdminAuth(",
  "requireAdminMutationAuth(",
];

const DEBUG_GUARD_TOKENS = ["requireDebugEnabled("];

function normalizePath(value) {
  return value.split(sep).join("/");
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/generate-protected-route-manifest.mjs",
      "  node scripts/generate-protected-route-manifest.mjs --check",
      "  node scripts/generate-protected-route-manifest.mjs --help",
      "",
      "Behavior:",
      "  - default mode: writes src/app/api/auth/protected-route-manifest.json",
      "  - --check: validates only; does not write files",
      "  - stdout: single JSON summary line",
      "",
    ].join("\n"),
  );
}

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function exportedMethods(source) {
  return METHODS.filter((method) => {
    const functionPattern = new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${method}\\b`,
      "m",
    );
    const constPattern = new RegExp(
      `export\\s+const\\s+${method}\\s*=`,
      "m",
    );
    return functionPattern.test(source) || constPattern.test(source);
  });
}

function toApiPath(routeFile) {
  const rel = relative(API_ROOT, routeFile);
  return `/api/${normalizePath(rel).replace(/\/route\.ts$/, "")}`;
}

/**
 * Strip block comments, line comments, and string literals so that tokens
 * appearing only inside comments or strings are not treated as real calls.
 */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
}

/**
 * Extract the source region for a specific exported HTTP method handler.
 * Falls back to the full source if the method boundary cannot be determined.
 */
function getMethodSource(source, method) {
  const methodNames = METHODS.join("|");
  const patterns = [
    new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${method}\\b[\\s\\S]*?(?=\\nexport\\s+(?:(?:async\\s+)?function|const)\\s+(?:${methodNames})\\b|$)`,
    ),
    new RegExp(
      `export\\s+const\\s+${method}\\s*=\\s*[\\s\\S]*?(?=\\nexport\\s+(?:(?:async\\s+)?function|const)\\s+(?:${methodNames})\\b|$)`,
    ),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return source;
}

function getHelperSources(source, fnName) {
  const strippedSource = stripCommentsAndStrings(source);
  const endBoundary =
    "(?=\\n(?:export\\s+)?(?:(?:async\\s+)?function|const)\\s+\\w+\\b|$)";
  const patterns = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${fnName}\\b[\\s\\S]*?${endBoundary}`,
    ),
    new RegExp(
      `(?:export\\s+)?const\\s+${fnName}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-zA-Z_]\\w*)\\s*=>[\\s\\S]*?${endBoundary}`,
    ),
  ];

  return patterns
    .map((pattern) => strippedSource.match(pattern))
    .filter(Boolean)
    .map((match) => match[0]);
}

/**
 * Check whether a method handler, or a helper it directly delegates to in the
 * same file, contains at least one of the supplied tokens.
 */
function methodHasAnyToken(source, method, tokens) {
  const methodBody = stripCommentsAndStrings(getMethodSource(source, method));

  if (tokens.some((token) => methodBody.includes(token))) {
    return true;
  }

  const calledFunctions = [
    ...new Set(
      (methodBody.match(/\b([a-zA-Z_]\w*)\s*\(/g) ?? [])
        .map((call) => call.replace(/\s*\($/, ""))
        .filter((name) => !METHODS.includes(name)),
    ),
  ];

  for (const fnName of calledFunctions) {
    const helperSources = getHelperSources(source, fnName);
    if (
      helperSources.some((helperSource) =>
        tokens.some((token) => helperSource.includes(token)),
      )
    ) {
      return true;
    }
  }

  return false;
}

function discoverRoutes() {
  return ROUTE_ROOTS.flatMap(({ kind, root }) => {
    try {
      return walk(root).map((file) => ({ kind, file }));
    } catch {
      return [];
    }
  })
    .filter(
      ({ file }) =>
        file.endsWith(`${sep}route.ts`) || file.endsWith("/route.ts"),
    )
    .filter(({ file }) => !file.endsWith(".test.ts"))
    .flatMap(({ kind, file }) => {
      const source = readFileSync(file, "utf8");
      const path = toApiPath(file);
      return exportedMethods(source).map((method) => ({
        kind,
        method,
        path,
        file,
        source,
      }));
    })
    .sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    );
}

function findPolicyViolations(routes) {
  const violations = [];

  for (const route of routes) {
    const file = normalizePath(relative(PROJECT_ROOT, route.file));

    if (!methodHasAnyToken(route.source, route.method, AUTH_TOKENS)) {
      violations.push({
        code: "MISSING_AUTH_GATE",
        kind: route.kind,
        requirement: "auth",
        method: route.method,
        path: route.path,
        file,
      });
    }

    if (
      route.kind === "debug" &&
      !methodHasAnyToken(route.source, route.method, DEBUG_GUARD_TOKENS)
    ) {
      violations.push({
        code: "MISSING_DEBUG_GUARD",
        kind: route.kind,
        requirement: "debug-enabled",
        method: route.method,
        path: route.path,
        file,
      });
    }
  }

  return violations.sort((a, b) =>
    `${a.method} ${a.path} ${a.code}`.localeCompare(
      `${b.method} ${b.path} ${b.code}`,
    ),
  );
}

function structuralFingerprint(content) {
  try {
    const parsed = JSON.parse(content);
    const { generatedAt: _ignored, ...rest } = parsed;
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const CHECK_ONLY = args.has("--check");

const discovered = discoverRoutes();
const violations = findPolicyViolations(discovered);
const unauthenticatedRoutes = violations
  .filter((violation) => violation.code === "MISSING_AUTH_GATE")
  .map(({ method, path, file }) => ({
    method,
    path,
    file,
  }));

const manifest = {
  version: 3,
  generatedAt: new Date().toISOString(),
  roots: ROUTE_ROOTS.map(({ root }) =>
    normalizePath(relative(PROJECT_ROOT, root)),
  ),
  discoveredRouteCount: discovered.length,
  unauthenticatedRouteCount: unauthenticatedRoutes.length,
  violationCount: violations.length,
  routes: discovered.map(({ method, path }) => ({ method, path })),
  unauthenticatedRoutes,
  violations,
};

const nextContent = `${JSON.stringify(manifest, null, 2)}\n`;

const previousContent = existsSync(MANIFEST_PATH)
  ? readFileSync(MANIFEST_PATH, "utf8")
  : null;

const previousFingerprint = previousContent
  ? structuralFingerprint(previousContent)
  : null;
const nextFingerprint = structuralFingerprint(nextContent);

const staleManifest =
  previousFingerprint === null || previousFingerprint !== nextFingerprint;
const diffStatus = staleManifest ? "dirty" : "clean";

let writeStatus = "skipped";
if (!CHECK_ONLY) {
  if (staleManifest) {
    writeFileSync(MANIFEST_PATH, nextContent, "utf8");
    writeStatus = "updated";
  } else {
    writeStatus = "unchanged";
  }
}

const result = {
  schemaVersion: 2,
  type: "protected-route-manifest",
  mode: CHECK_ONLY ? "check" : "write",
  generatedAt: manifest.generatedAt,
  manifestPath: normalizePath(relative(PROJECT_ROOT, MANIFEST_PATH)),
  discoveredRouteCount: manifest.discoveredRouteCount,
  unauthenticatedRouteCount: manifest.unauthenticatedRouteCount,
  violationCount: manifest.violationCount,
  violations: manifest.violations,
  diffStatus,
  staleManifest,
  writeStatus,
};

process.stdout.write(`${JSON.stringify(result)}\n`);

let exitCode = 0;
if (violations.length > 0) {
  exitCode = 1;
} else if (CHECK_ONLY && staleManifest) {
  exitCode = 2;
}

process.exit(exitCode);
