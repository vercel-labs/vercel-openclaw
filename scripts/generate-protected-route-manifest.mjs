#!/usr/bin/env node
/**
 * Generate a sorted manifest of all protected admin and firewall route handlers.
 *
 * Usage:
 *   node scripts/generate-protected-route-manifest.mjs
 *
 * Output:
 *   - Writes src/app/api/auth/protected-route-manifest.json
 *   - Prints a single JSON summary line to stdout (machine-readable)
 *   - Exits 0 when unauthenticatedRouteCount is 0; non-zero otherwise
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
  join(API_ROOT, "admin"),
  join(API_ROOT, "firewall"),
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const AUTH_TOKENS = [
  "requireJsonRouteAuth(",
  "requireMutationAuth(",
  "requireAdminAuth(",
  "requireAdminMutationAuth(",
];

function normalizePath(value) {
  return value.split(sep).join("/");
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
    const fnPattern = new RegExp(
      `export\\s+async\\s+function\\s+${method}\\b`,
      "m",
    );
    const constPattern = new RegExp(
      `export\\s+const\\s+${method}\\s*=`,
      "m",
    );
    return fnPattern.test(source) || constPattern.test(source);
  });
}

function toApiPath(routeFile) {
  const rel = relative(API_ROOT, routeFile);
  return `/api/${normalizePath(rel).replace(/\/route\.ts$/, "")}`;
}

function discoverRoutes() {
  return ROUTE_ROOTS.flatMap((root) => {
    try {
      return walk(root);
    } catch {
      return [];
    }
  })
    .filter((file) => file.endsWith(`${sep}route.ts`) || file.endsWith("/route.ts"))
    .filter((file) => !file.endsWith(".test.ts"))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const path = toApiPath(file);
      return exportedMethods(source).map((method) => ({
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

function findUnauthenticatedRoutes(routes) {
  return routes
    .filter(({ source }) => !AUTH_TOKENS.some((token) => source.includes(token)))
    .map(({ method, file }) => ({
      method,
      file: normalizePath(relative(PROJECT_ROOT, file)),
    }))
    .sort((a, b) =>
      `${a.method} ${a.file}`.localeCompare(`${b.method} ${b.file}`),
    );
}

const discovered = discoverRoutes();
const unauthenticatedRoutes = findUnauthenticatedRoutes(discovered);

const manifest = {
  version: 2,
  generatedAt: new Date().toISOString(),
  roots: ROUTE_ROOTS.map((root) => normalizePath(relative(PROJECT_ROOT, root))),
  discoveredRouteCount: discovered.length,
  unauthenticatedRouteCount: unauthenticatedRoutes.length,
  routes: discovered.map(({ method, path }) => ({ method, path })),
  unauthenticatedRoutes,
};

const nextContent = `${JSON.stringify(manifest, null, 2)}\n`;

// Compare structural content only (ignore generatedAt timestamp) for idempotency
function structuralFingerprint(content) {
  try {
    const parsed = JSON.parse(content);
    const { generatedAt: _, ...rest } = parsed;
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

const previousContent = existsSync(MANIFEST_PATH)
  ? readFileSync(MANIFEST_PATH, "utf8")
  : null;

const previousFingerprint = previousContent
  ? structuralFingerprint(previousContent)
  : null;
const nextFingerprint = structuralFingerprint(nextContent);
const diffStatus =
  previousFingerprint !== null && previousFingerprint === nextFingerprint
    ? "clean"
    : "dirty";

writeFileSync(MANIFEST_PATH, nextContent, "utf8");

const result = {
  schemaVersion: 1,
  type: "protected-route-manifest",
  generatedAt: manifest.generatedAt,
  manifestPath: normalizePath(relative(PROJECT_ROOT, MANIFEST_PATH)),
  discoveredRouteCount: manifest.discoveredRouteCount,
  unauthenticatedRouteCount: manifest.unauthenticatedRouteCount,
  unauthenticatedRoutes: manifest.unauthenticatedRoutes,
  diffStatus,
  writeStatus: diffStatus === "clean" ? "unchanged" : "updated",
};

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(unauthenticatedRoutes.length === 0 ? 0 : 1);
