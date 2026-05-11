import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE,
  REQUIRED_BUNDLE_METADATA_ASSETS,
  REQUIRED_DASHBOARD_BUNDLE_ASSETS,
  validateBundleAssetManifestForDashboard,
} from "@/server/openclaw/bundle-compatibility";

function manifest(assetNames = [...REQUIRED_DASHBOARD_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS]) {
  return {
    schemaVersion: 1,
    name: "openclaw-sandbox-bundle",
    profile: "sandbox",
    assets: Object.fromEntries(
      assetNames.map((name) => [name, { role: name, bytes: 1, sha256: "a".repeat(64) }]),
    ),
  };
}

test("validateBundleAssetManifestForDashboard accepts the existing OpenClaw release manifest", () => {
  const result = validateBundleAssetManifestForDashboard(manifest());

  assert.equal(result.ok, true);
});

test("validateBundleAssetManifestForDashboard rejects invalid manifest shape with shared code", () => {
  const result = validateBundleAssetManifestForDashboard({ schemaVersion: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.issue.code, OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE);
  assert.equal(result.issue.reason, "schema-version");
});

test("validateBundleAssetManifestForDashboard rejects missing required dashboard sidecar", () => {
  const assetNames = [...REQUIRED_DASHBOARD_BUNDLE_ASSETS, ...REQUIRED_BUNDLE_METADATA_ASSETS]
    .filter((name) => name !== "control-ui.tar.gz");
  const result = validateBundleAssetManifestForDashboard(manifest(assetNames));

  assert.equal(result.ok, false);
  assert.equal(result.issue.reason, "required-asset-missing");
  assert.match(result.issue.detail, /control-ui\.tar\.gz/);
});

test("validateBundleAssetManifestForDashboard warns instead of failing for optional shared chunks", () => {
  const result = validateBundleAssetManifestForDashboard(manifest());

  assert.equal(result.ok, true);
  assert.equal(result.warnings[0].reason, "optional-asset-missing");
});

test("validateBundleAssetManifestForDashboard allows unknown extra assets", () => {
  const result = validateBundleAssetManifestForDashboard({
    ...manifest(),
    assets: {
      ...manifest().assets,
      "future.tar.gz": { role: "future", bytes: 1, sha256: "b".repeat(64) },
    },
  });

  assert.equal(result.ok, true);
});
