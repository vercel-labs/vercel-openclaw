import { getAuthMode } from "@/server/env";
import { logDebug, logInfo, logWarn } from "@/server/log";

export type PublicOriginSource =
  | "NEXT_PUBLIC_APP_URL"
  | "NEXT_PUBLIC_BASE_DOMAIN"
  | "BASE_DOMAIN"
  | "x-forwarded-host"
  | "host"
  | "request-url"
  | "VERCEL_PROJECT_PRODUCTION_URL"
  | "VERCEL_BRANCH_URL"
  | "VERCEL_URL";

export type PublicOriginResolution = {
  origin: string;
  source: PublicOriginSource;
  authMode: ReturnType<typeof getAuthMode>;
  requestHost: string | null;
  requestProto: string | null;
  explicitValue: string | null;
  vercelHost: string | null;
  bypassEnabled: boolean;
};

export type BuiltPublicUrlDiagnostics = {
  path: string;
  url: string;
  source: PublicOriginSource;
  authMode: ReturnType<typeof getAuthMode>;
  bypassEnabled: boolean;
  bypassApplied: boolean;
};

type BuildPublicUrlResult = {
  url: string;
  diagnostics: BuiltPublicUrlDiagnostics;
};

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Public origin is empty.");
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return new URL(trimmed).origin;
  }

  return new URL(`https://${trimmed}`).origin;
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

function sanitizeUrlForLogs(value: string): string {
  const url = new URL(value);
  if (url.searchParams.has("x-vercel-protection-bypass")) {
    url.searchParams.set("x-vercel-protection-bypass", "[redacted]");
  }
  return url.toString();
}

function getExplicitOriginValue(): {
  value: string;
  source: PublicOriginSource;
} | null {
  const nextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (nextPublicAppUrl) {
    return { value: nextPublicAppUrl, source: "NEXT_PUBLIC_APP_URL" };
  }

  const nextPublicBaseDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN?.trim();
  if (nextPublicBaseDomain) {
    return { value: nextPublicBaseDomain, source: "NEXT_PUBLIC_BASE_DOMAIN" };
  }

  const baseDomain = process.env.BASE_DOMAIN?.trim();
  if (baseDomain) {
    return { value: baseDomain, source: "BASE_DOMAIN" };
  }

  return null;
}

function getVercelOriginValue(): {
  value: string;
  source: PublicOriginSource;
} | null {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionUrl) {
    return { value: productionUrl, source: "VERCEL_PROJECT_PRODUCTION_URL" };
  }

  const branchUrl = process.env.VERCEL_BRANCH_URL?.trim();
  if (branchUrl) {
    return { value: branchUrl, source: "VERCEL_BRANCH_URL" };
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return { value: vercelUrl, source: "VERCEL_URL" };
  }

  return null;
}

export function getProtectionBypassSecret(): string | null {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return secret || null;
}

export function resolvePublicOrigin(
  request?: Request,
): PublicOriginResolution {
  const authMode = getAuthMode();
  const bypassEnabled = Boolean(getProtectionBypassSecret());

  const explicit = getExplicitOriginValue();
  const vercel = getVercelOriginValue();

  const requestForwardedHost = firstHeaderValue(
    request?.headers.get("x-forwarded-host") ?? null,
  );
  const requestHostHeader = firstHeaderValue(
    request?.headers.get("host") ?? null,
  );
  const requestHostFromUrl = request ? new URL(request.url).host : null;
  const requestProto =
    firstHeaderValue(request?.headers.get("x-forwarded-proto") ?? null) ||
    (request ? new URL(request.url).protocol.replace(/:$/, "") : null);
  const requestHost =
    requestForwardedHost ?? requestHostHeader ?? requestHostFromUrl;

  if (explicit) {
    return {
      origin: normalizeOrigin(explicit.value),
      source: explicit.source,
      authMode,
      requestHost,
      requestProto,
      explicitValue: explicit.value,
      vercelHost: vercel?.value ?? null,
      bypassEnabled,
    };
  }

  if (requestForwardedHost) {
    return {
      origin: normalizeOrigin(
        `${requestProto ?? "https"}://${requestForwardedHost}`,
      ),
      source: "x-forwarded-host",
      authMode,
      requestHost,
      requestProto,
      explicitValue: null,
      vercelHost: vercel?.value ?? null,
      bypassEnabled,
    };
  }

  if (requestHostHeader) {
    return {
      origin: normalizeOrigin(
        `${requestProto ?? "https"}://${requestHostHeader}`,
      ),
      source: "host",
      authMode,
      requestHost,
      requestProto,
      explicitValue: null,
      vercelHost: vercel?.value ?? null,
      bypassEnabled,
    };
  }

  if (requestHostFromUrl) {
    return {
      origin: normalizeOrigin(
        `${requestProto ?? "https"}://${requestHostFromUrl}`,
      ),
      source: "request-url",
      authMode,
      requestHost,
      requestProto,
      explicitValue: null,
      vercelHost: vercel?.value ?? null,
      bypassEnabled,
    };
  }

  if (vercel) {
    return {
      origin: normalizeOrigin(vercel.value),
      source: vercel.source,
      authMode,
      requestHost,
      requestProto,
      explicitValue: null,
      vercelHost: vercel.value,
      bypassEnabled,
    };
  }

  logWarn("public_origin.unresolved", {
    authMode,
    bypassEnabled,
    hasRequest: Boolean(request),
    requestHost,
    requestProto,
  });

  throw new Error(
    "Unable to determine public origin. Set NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_BASE_DOMAIN, BASE_DOMAIN, or enable Vercel system environment variables.",
  );
}

function buildPublicUrlResult(
  path: string,
  request?: Request,
): BuildPublicUrlResult {
  const resolution = resolvePublicOrigin(request);
  const url = new URL(path, `${resolution.origin}/`);

  let bypassApplied = false;
  const secret = getProtectionBypassSecret();
  if (secret) {
    url.searchParams.set("x-vercel-protection-bypass", secret);
    bypassApplied = true;
  }

  const diagnostics: BuiltPublicUrlDiagnostics = {
    path,
    url: sanitizeUrlForLogs(url.toString()),
    source: resolution.source,
    authMode: resolution.authMode,
    bypassEnabled: resolution.bypassEnabled,
    bypassApplied,
  };

  logInfo("public_url.built", diagnostics);

  return {
    url: url.toString(),
    diagnostics,
  };
}

export function getPublicOrigin(request?: Request): string {
  return resolvePublicOrigin(request).origin;
}

export function getPublicUrlDiagnostics(
  path: string,
  request?: Request,
): BuiltPublicUrlDiagnostics {
  return buildPublicUrlResult(path, request).diagnostics;
}

export function buildPublicUrl(path: string, request?: Request): string {
  return buildPublicUrlResult(path, request).url;
}

/**
 * Build a public URL suitable for admin-visible surfaces (status JSON, UI).
 *
 * Identical to `buildPublicUrl` but **never** includes the bypass secret in
 * the returned URL.  Diagnostics still indicate whether bypass is enabled.
 */
export function buildPublicDisplayUrl(path: string, request?: Request): string {
  const resolution = resolvePublicOrigin(request);
  const url = new URL(path, `${resolution.origin}/`);

  const bypassEnabled = Boolean(getProtectionBypassSecret());

  const diagnostics: BuiltPublicUrlDiagnostics = {
    path,
    url: url.toString(),
    source: resolution.source,
    authMode: resolution.authMode,
    bypassEnabled,
    bypassApplied: false,
  };

  logDebug("public_display_url.built", diagnostics);

  return url.toString();
}

/**
 * Resolve the canonical public origin from a raw origin hint string.
 *
 * This is intended for background jobs and queue consumers that receive an
 * origin string (not a full `Request`). If the hint is empty/null, falls back
 * to env-based resolution via `getPublicOrigin()`.
 */
export function getPublicOriginFromHint(
  originHint?: string | null,
): string {
  const normalized = originHint?.trim();
  if (!normalized) {
    return getPublicOrigin();
  }

  const requestUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)
    ? normalized
    : `https://${normalized}`;

  return getPublicOrigin(new Request(requestUrl));
}
