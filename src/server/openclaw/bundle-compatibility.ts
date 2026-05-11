export const OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE =
  "OPENCLAW_BUNDLE_COMPATIBILITY_MISMATCH";

export const INVALID_BUNDLE_ASSET_MANIFEST_JSON = Symbol(
  "INVALID_BUNDLE_ASSET_MANIFEST_JSON",
);

export const REQUIRED_DASHBOARD_BUNDLE_ASSETS = [
  "openclaw.bundle.mjs",
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "channels.tar.gz",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "control-ui.tar.gz",
] as const;

export const REQUIRED_BUNDLE_METADATA_ASSETS = [
  "asset-manifest.json",
  "bundle-contract.json",
  "release.json",
  "checksums.sha256",
] as const;

export const OPTIONAL_DASHBOARD_BUNDLE_ASSETS = ["channel-shared-chunks.tar.gz"] as const;

export type BundleCompatibilityIssue = {
  code: typeof OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE;
  reason:
    | "manifest-missing"
    | "invalid-json"
    | "schema-version"
    | "name-profile"
    | "assets-missing"
    | "required-asset-missing"
    | "asset-record-invalid"
    | "optional-asset-missing";
  detail: string;
};

export type BundleCompatibilityResult =
  | { ok: true; warnings: BundleCompatibilityIssue[] }
  | { ok: false; issue: BundleCompatibilityIssue; warnings: BundleCompatibilityIssue[] };

function issue(reason: BundleCompatibilityIssue["reason"], detail: string): BundleCompatibilityIssue {
  return { code: OPENCLAW_BUNDLE_COMPATIBILITY_ERROR_CODE, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateBundleAssetManifestForDashboard(
  manifest: unknown,
): BundleCompatibilityResult {
  const warnings: BundleCompatibilityIssue[] = [];
  if (manifest === INVALID_BUNDLE_ASSET_MANIFEST_JSON) {
    return { ok: false, issue: issue("invalid-json", "asset-manifest.json is not valid JSON"), warnings };
  }
  if (!isRecord(manifest)) {
    return { ok: false, issue: issue("invalid-json", "asset-manifest.json must be an object"), warnings };
  }
  if (manifest.schemaVersion !== 1) {
    return { ok: false, issue: issue("schema-version", "asset-manifest.json schemaVersion must be 1"), warnings };
  }
  if (manifest.name !== "openclaw-sandbox-bundle" || manifest.profile !== "sandbox") {
    return {
      ok: false,
      issue: issue("name-profile", "asset-manifest.json must describe the sandbox bundle"),
      warnings,
    };
  }
  if (!isRecord(manifest.assets)) {
    return { ok: false, issue: issue("assets-missing", "asset-manifest.json lacks assets"), warnings };
  }

  const requiredAssets = [
    ...REQUIRED_DASHBOARD_BUNDLE_ASSETS,
    ...REQUIRED_BUNDLE_METADATA_ASSETS,
  ];
  for (const assetName of requiredAssets) {
    const record = manifest.assets[assetName];
    if (!isRecord(record)) {
      return {
        ok: false,
        issue: issue("required-asset-missing", `asset-manifest.json lacks assets.${assetName}`),
        warnings,
      };
    }
    if (typeof record.bytes !== "number" || record.bytes <= 0 || typeof record.sha256 !== "string") {
      return {
        ok: false,
        issue: issue("asset-record-invalid", `asset-manifest.json has invalid record for ${assetName}`),
        warnings,
      };
    }
  }

  for (const assetName of OPTIONAL_DASHBOARD_BUNDLE_ASSETS) {
    if (!manifest.assets[assetName]) {
      warnings.push(issue("optional-asset-missing", `${assetName} is absent`));
    }
  }
  return { ok: true, warnings };
}

export function formatBundleCompatibilityIssue(issue: BundleCompatibilityIssue): string {
  return `${issue.code}: ${issue.detail}`;
}
