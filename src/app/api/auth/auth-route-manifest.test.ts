/**
 * Protected route manifest tests.
 *
 * The generator script is the canonical audit engine.
 * This test verifies:
 *   1. The checked-in manifest is current.
 *   2. No route policy violations are present.
 *
 * Run:
 *   npm test src/app/api/auth/auth-route-manifest.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

type ProtectedRouteViolationCode =
  | "MISSING_AUTH_GATE"
  | "MISSING_DEBUG_GUARD";

type ProtectedRouteViolation = {
  code: ProtectedRouteViolationCode;
  kind: "admin" | "firewall" | "debug";
  requirement: "auth" | "debug-enabled";
  method: string;
  path: string;
  file: string;
};

type ProtectedRouteAuditResult = {
  schemaVersion: number;
  type: "protected-route-manifest";
  mode: "check" | "write";
  generatedAt: string;
  manifestPath: string;
  discoveredRouteCount: number;
  unauthenticatedRouteCount: number;
  violationCount: number;
  violations: ProtectedRouteViolation[];
  diffStatus: "clean" | "dirty";
  staleManifest: boolean;
  writeStatus: "skipped" | "unchanged" | "updated";
};

function runProtectedRouteAudit(): {
  exitCode: number;
  result: ProtectedRouteAuditResult;
  stderr: string;
} {
  const proc = spawnSync(
    "node",
    ["scripts/generate-protected-route-manifest.mjs", "--check"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  assert.notEqual(
    proc.stdout.trim(),
    "",
    `Protected route audit produced no stdout.\nstderr:\n${proc.stderr}`,
  );

  let parsed: ProtectedRouteAuditResult | null = null;
  try {
    parsed = JSON.parse(proc.stdout.trim()) as ProtectedRouteAuditResult;
  } catch (error) {
    assert.fail(
      [
        "Protected route audit did not return valid JSON.",
        `stdout:\n${proc.stdout}`,
        `stderr:\n${proc.stderr}`,
        `parseError: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
  }

  if (!parsed) {
    assert.fail("Protected route audit parsing unexpectedly returned null.");
  }

  return {
    exitCode: proc.status ?? 1,
    result: parsed,
    stderr: proc.stderr,
  };
}

test("protected route audit returns machine-readable JSON", () => {
  const { result } = runProtectedRouteAudit();

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.type, "protected-route-manifest");
  assert.equal(result.mode, "check");
  assert.equal(typeof result.generatedAt, "string");
  assert.equal(typeof result.manifestPath, "string");
  assert.equal(typeof result.discoveredRouteCount, "number");
  assert.equal(typeof result.unauthenticatedRouteCount, "number");
  assert.equal(typeof result.violationCount, "number");
  assert.ok(Array.isArray(result.violations));
  assert.ok(["clean", "dirty"].includes(result.diffStatus));
  assert.equal(result.writeStatus, "skipped");
});

test("protected route manifest matches current protected surface", () => {
  const { result } = runProtectedRouteAudit();

  assert.equal(
    result.diffStatus,
    "clean",
    [
      "Protected route manifest is stale.",
      "Run: node scripts/generate-protected-route-manifest.mjs",
      "",
      JSON.stringify(result, null, 2),
    ].join("\n"),
  );
});

test("every protected route satisfies its policy", () => {
  const { result } = runProtectedRouteAudit();

  assert.deepEqual(
    result.violations,
    [],
    [
      "Protected route policy violations detected.",
      JSON.stringify(result.violations, null, 2),
    ].join("\n"),
  );
});
