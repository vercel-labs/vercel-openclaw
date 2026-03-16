/**
 * Auth helper for the remote smoke runner.
 *
 * - In `sign-in-with-vercel` mode: reads SMOKE_AUTH_COOKIE from env
 *   (or accepts a CLI override) and attaches it as a Cookie header.
 * - In `admin-secret` mode: uses bearer token auth. If the deployment also
 *   has Vercel deployment protection, reads VERCEL_AUTOMATION_BYPASS_SECRET
 *   from env (or accepts a CLI override via --protection-bypass) and sends
 *   the `x-vercel-protection-bypass` header.
 */

/** Module-level cookie override set by the CLI via `setAuthCookie()`. */
let _cookieOverride: string | undefined;

/** Module-level bypass secret override set by the CLI via `setProtectionBypass()`. */
let _bypassOverride: string | undefined;

/**
 * Set an explicit auth cookie value. Takes precedence over SMOKE_AUTH_COOKIE env var.
 * Used by the CLI when `--auth-cookie` is supplied.
 * Pass `undefined` to clear a previously set override.
 */
export function setAuthCookie(value: string | undefined): void {
  _cookieOverride = value;
}

/**
 * Set an explicit protection bypass secret. Takes precedence over
 * VERCEL_AUTOMATION_BYPASS_SECRET env var.
 * Used by the CLI when `--protection-bypass` is supplied.
 */
export function setProtectionBypass(value: string | undefined): void {
  _bypassOverride = value;
}

/**
 * Return which auth source is active, for diagnostics.
 */
export function getAuthSource(): string {
  if (_cookieOverride) return "cli-cookie";
  if (process.env.SMOKE_AUTH_COOKIE) return "env-cookie";
  if (_bypassOverride) return "cli-bypass";
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) return "env-bypass";
  return "none";
}

/**
 * Build headers for an authenticated request.
 * GET/HEAD requests only need the cookie/bypass (if any).
 * Mutation requests (POST/PUT/DELETE) also need the CSRF header.
 */
export function authHeaders(
  opts: { mutation?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};

  const cookie = _cookieOverride ?? process.env.SMOKE_AUTH_COOKIE;
  if (cookie) {
    headers.Cookie = cookie;
  }

  const bypass = _bypassOverride ?? process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
  }

  if (opts.mutation) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }

  return headers;
}
