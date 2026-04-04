# Proxy & HTML Injection Safety Audit

**Date**: 2026-04-03
**Scope**: Gateway proxy auth gating, HTML token injection, upstream response handling, redirect safety, path traversal protection

## Files Audited

- `src/app/gateway/[[...path]]/route.ts`
- `src/server/proxy/htmlInjection.ts`
- `src/server/proxy/proxy-route-utils.ts`
- `src/server/auth/admin-auth.ts`
- `src/server/auth/session.ts`
- `src/server/auth/vercel-auth.ts`
- `src/server/auth/csrf.ts`
- `src/app/api/auth/auth-enforcement.test.ts`

## Findings

### PASS — Auth runs before proxying and before HTML injection

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:85-88` — `requireGatewayAuth(request, reqCtx)` is called at line 85. If it returns a `Response` (401/403), the function returns immediately at line 87. All proxy logic (sandbox ensure, upstream fetch, HTML injection) occurs only after auth succeeds.
- **Details**: `requireGatewayAuth` (lines 38-62) dispatches to `requireAdminAuth` for safe methods (GET/HEAD/OPTIONS) and `requireAdminMutationAuth` for mutations (POST/PUT/PATCH/DELETE). Both use timing-safe bearer comparison and encrypted cookie sessions. CSRF is enforced on cookie-based mutations before session validation.

### PASS — Gateway token never leaked in unauthenticated responses

- **Evidence**: `src/app/api/auth/auth-enforcement.test.ts:252-278` (GET), `280-312` (POST), `406-430` (subpath), `477-502` (corrupted cookie)
- **Details**: Four distinct test scenarios verify that the gateway token does not appear in response bodies when auth fails. The test at line 259 seeds `gatewayToken: "secret-gateway-token"` into metadata, sends an unauthenticated GET, and asserts `!text.includes("secret-gateway-token")`.

### PASS — Injected script escapes `<` to prevent breakout

- **Evidence**: `src/server/proxy/htmlInjection.ts:9-22` — `escapeForInlineScriptJson` replaces `<` with `\\u003c`, U+2028 with `\\u2028`, and U+2029 with `\\u2029`.
- **Details**: The gateway token and sandbox origin are serialized via `JSON.stringify` then passed through this escaper before being embedded in a `<script>` block (line 33). This prevents a malicious upstream from injecting `</script>` via a crafted sandbox origin or token value.

### PASS — Token handoff uses URL hash fragment (not query string)

- **Evidence**: `src/server/proxy/htmlInjection.ts:196-202`
- **Details**: The injected script sets `location.hash` with the gateway token via `history.replaceState`. Hash fragments are never sent to servers in HTTP requests, so the token cannot leak via Referer headers, server logs, or analytics. The inline comment at line 192-195 documents this rationale.

### PASS — Referrer policy prevents token leakage on navigation

- **Evidence**: `src/server/proxy/htmlInjection.ts:213` — `<meta name="referrer" content="no-referrer">` is injected into `<head>`.
- **Details**: This prevents the browser from sending any referrer when navigating away from the proxied page, which is defense-in-depth against leaking the gateway origin or path to third-party resources loaded by the proxied app.

### PASS — Strict Content Security Policy on injected HTML

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:190-202` — `buildTokenHtmlHeaders`
- **Details**: CSP restricts `connect-src` to `'self'`, the sandbox origin (HTTPS and WSS), and the proxy origin. `img-src` allows only `'self'`, `data:`, and `blob:`. `form-action` and `base-uri` are locked to `'self'`. `X-Frame-Options: DENY` prevents clickjacking. `Cache-Control: no-store, private` prevents caching of token-bearing HTML.

### PASS — Upstream response headers scrubbed of secrets

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:157-179` — `stripProxyResponseHeaders`
- **Details**: Strips `set-cookie`, `authorization`, `content-security-policy`, `x-frame-options`, `referrer-policy`, and hop-by-hop headers. Additionally, any header whose value contains a known secret string (line 172-174) is omitted entirely. The gateway token is passed as a secret at `route.ts:213`.

### PASS — Sensitive query params stripped before forwarding

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:98-107` — `sanitizeProxyQueryParams`
- **Details**: Removes `token`, `authorization`, and any param starting with `_` before forwarding to the sandbox. This prevents the browser from accidentally including auth material in query strings that could be logged by the upstream.

### PASS — Proxy request headers sanitized

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:120-155` — `buildSafeProxyHeaders`
- **Details**: Only an explicit allowlist of safe headers is forwarded (lines 1-13). `cookie`, `authorization`, `origin`, and `referer` from the original request are explicitly blocked (lines 17-21, 139-141). The proxy injects its own `Authorization: Bearer <gatewayToken>` header (route.ts:139) so the upstream never sees the admin's cookie or bearer token.

### PASS — Path traversal protection

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:64-96` — `isInvalidProxyTargetPath`
- **Details**: Rejects paths containing backslashes, NUL bytes, encoded NUL (`%00`), encoded slashes (`%2f`, `%5c`), and `.`/`..` segments. Double-decoding is checked (two rounds of `decodeURIComponent`) to catch double-encoded bypass attempts. The gateway route calls this at `route.ts:81-83`.

### PASS — Redirect blocking prevents open redirect from upstream

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:214-257`
- **Details**: Protocol-relative redirects (`//evil.com`) are caught and replaced with a safe HTML block (lines 217-231). Same-host redirects are rewritten to relative paths (lines 235-239). Cross-origin redirects have their `Location` header removed entirely (lines 240-241). This prevents the upstream sandbox from redirecting the authenticated user to a malicious site.

### PASS — 401 retry for expired OIDC token is safe

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:180-196`
- **Details**: When the upstream returns 401 (expired OIDC token inside the sandbox), the proxy force-refreshes the token and retries once. The retry uses the same `buildFetchInit(bodyBytes)` as the original request. The request body is buffered at line 143-145 before the first fetch, so replay is safe. Retry failure falls through to the original 401 response.

### PASS — 410 upstream triggers reconciliation, not error exposure

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:198-211`
- **Details**: A 410 from the sandbox (gateway revoked) triggers `reconcileSandboxHealth` in background and returns the waiting page, not an error response with internal details.

### WARN — `'unsafe-inline'` in CSP allows injected app XSS to access gateway token

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:196` — `default-src 'self' 'unsafe-inline'`
- **Severity**: P3 (architectural trade-off, not a bug)
- **Details**: The CSP includes `'unsafe-inline'` because the injected interceptor script itself is inline. This means any XSS vulnerability in the proxied OpenClaw app could read `GATEWAY_TOKEN` from the closure or the URL hash. The risk is mitigated by: (1) the CSP's `connect-src` whitelist limits where stolen tokens can be exfiltrated, (2) the gateway token authenticates only to the sandbox gateway (not admin APIs), and (3) the operator controls the OpenClaw version installed in the sandbox.
- **Recommended fix**: None required for launch. A future improvement could use a nonce-based CSP (`'nonce-<random>'`) on the injected script and remove `'unsafe-inline'`, but this requires the proxied app's inline scripts to also carry the nonce, which is not feasible without deeper HTML rewriting.

### WARN — WebSocket sub-protocol carries gateway token in cleartext

- **Evidence**: `src/server/proxy/htmlInjection.ts:109-118` — `appendGatewayAuthProtocol`
- **Severity**: P3 (known design constraint)
- **Details**: The gateway token is appended as a WebSocket sub-protocol (`openclaw.gateway-token.<token>`) because the browser `WebSocket` API does not support custom headers. The sub-protocol is visible in browser dev tools and may be logged by intermediate WebSocket proxies. The connection is over WSS (TLS), so the token is not exposed on the wire. The risk is limited to the operator's own browser and any intermediate infrastructure they control.
- **Recommended fix**: None required. This is a standard pattern for WebSocket auth. Document in operator-facing security notes if not already covered.

## Test Coverage Assessment

| Area | Status | Evidence |
|---|---|---|
| Unauthenticated GET → 401 (no token leak) | Covered | `auth-enforcement.test.ts:252-278` |
| Unauthenticated POST → 403 CSRF (no token leak) | Covered | `auth-enforcement.test.ts:280-312` |
| Unauthenticated subpath GET → 401 (no token leak) | Covered | `auth-enforcement.test.ts:406-430` |
| Corrupted cookie → 401 (no token leak) | Covered | `auth-enforcement.test.ts:477-502` |
| Cookie POST without CSRF → 403 | Covered | `auth-enforcement.test.ts:646-685` |
| Bearer POST bypasses CSRF | Covered | `auth-enforcement.test.ts:687-733` |
| Authenticated GET proxies normally | Covered | `auth-enforcement.test.ts:314-358` |
| Path traversal rejection | **Gap** | No test for `isInvalidProxyTargetPath` return behavior in gateway route |
| Redirect blocking (protocol-relative, cross-origin) | **Gap** | No test for upstream redirect rewriting/blocking |
| HTML injection XSS escaping | **Gap** | No test that `escapeForInlineScriptJson` neutralizes `</script>` |
| Sensitive query param stripping | **Gap** | No test for `sanitizeProxyQueryParams` called from gateway route |

## Recommended Fixes (ranked by severity)

1. **P3** — Add unit tests for `escapeForInlineScriptJson` to verify `</script>` breakout is neutralized. Low effort, locks the security invariant.
2. **P3** — Add a gateway integration test for path traversal (e.g., `/gateway/../etc/passwd` → 400) to complement the unit tests in `proxy-route-utils.test.ts`.
3. **P3** — Add a gateway test for upstream redirect blocking (mock upstream returns `Location: //evil.com` → verify blocked).
4. **P3** — Document the `'unsafe-inline'` CSP trade-off in operator-facing security notes.
5. **P3** — Document WebSocket sub-protocol token exposure in operator-facing security notes.

## Launch Readiness

**No launch-blocking proxy or injection risks identified.** The gateway correctly gates all proxy and injection behavior behind admin auth. Token handoff uses hash fragments and referrer suppression to prevent leakage. Upstream responses are sanitized, redirects are blocked, and path traversal is rejected. The two WARN findings (CSP `unsafe-inline` and WebSocket sub-protocol) are known architectural trade-offs with limited blast radius. The test coverage gaps are for defense-in-depth assertions on already-correct code paths.
