# Firewall & Proxy Safety Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: PASS (with warnings)

## Scope

Files audited:

- `src/server/firewall/domains.ts`
- `src/server/firewall/policy.ts`
- `src/server/firewall/state.ts`
- `src/app/gateway/[[...path]]/route.ts`
- `src/server/proxy/proxy-route-utils.ts`
- `src/server/proxy/htmlInjection.ts`
- `src/server/proxy/waitingPage.ts`
- `src/server/proxy/pending-response.ts`
- `src/server/public-url.ts`

## Findings

### PASS -- Auth enforced before proxy

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:85-88`
- **Detail**: Every proxy request calls `requireGatewayAuth()` before any sandbox interaction or HTML injection. Mutation methods (POST, PUT, PATCH, DELETE) use `requireAdminMutationAuth` (CSRF-protected); read methods (GET, HEAD, OPTIONS) use `requireAdminAuth`. Auth failure returns a Response immediately, short-circuiting the proxy flow. The gateway token is never exposed to unauthenticated callers.

### PASS -- Gateway token not leaked in response headers

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:157-179` and `src/app/gateway/[[...path]]/route.ts:213,284`
- **Detail**: `stripProxyResponseHeaders()` accepts a `secrets` array and strips any response header whose value contains a secret. Both the non-HTML path (line 213) and the HTML path (line 284 via `buildTokenHtmlHeaders`) pass `meta.gatewayToken` as a secret. The `set-cookie` header is also unconditionally stripped from upstream responses (line 46), preventing session fixation from the sandbox.

### PASS -- Gateway token properly escaped in injected HTML

- **Evidence**: `src/server/proxy/htmlInjection.ts:9-22`
- **Detail**: `escapeForInlineScriptJson()` applies `JSON.stringify()` then replaces `<` with `\u003c`, and line separators U+2028/U+2029 with their Unicode escapes. The `<` replacement prevents `</script>` injection attacks inside the inline script block. JSON.stringify handles all other characters that could break out of the string context. The token is consumed via `JSON.parse` semantics in the IIFE, so there is no eval or innerHTML risk.

### PASS -- Token delivered via URL hash fragment, not query param

- **Evidence**: `src/server/proxy/htmlInjection.ts:196-202`
- **Detail**: The injected script writes the gateway token to `location.hash` (fragment identifier), which is never sent to servers in HTTP requests. The comment at line 192-195 correctly documents this. WebSocket connections strip the `token` query param (lines 160, 165) before constructing the URL, further preventing leakage.

### PASS -- Path traversal protection with double-decode guard

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:64-96`
- **Detail**: `isInvalidProxyTargetPath()` blocks backslashes, null bytes (raw and percent-encoded), encoded slashes (`%2f`, `%5c`), and `.`/`..` path segments. Critically, it performs up to two rounds of `decodeURIComponent` to catch double-encoding attacks (e.g., `%252e%252e`). If any decoding round reveals encoded slashes or invalid segments, the path is rejected. This is a solid defense against path traversal.

### PASS -- Upstream redirect blocking

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:214-257`
- **Detail**: The proxy uses `redirect: "manual"` (line 152) so redirects are not auto-followed. Protocol-relative redirects (`//`) are blocked entirely (lines 217-231). Absolute redirects to the sandbox host are rewritten to relative paths (lines 235-238). Redirects to any other host are silently dropped by deleting the `location` header (line 241). This prevents open-redirect attacks through the proxy.

### PASS -- Request header sanitization (allowlist approach)

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:1-13, 120-155`
- **Detail**: `buildSafeProxyHeaders()` uses a strict allowlist of safe header names. The `cookie`, `authorization`, `origin`, and `referer` headers are explicitly blocked. The proxy then injects its own `authorization: Bearer <gatewayToken>` header via `serverInjectedHeaders`. Hop-by-hop headers are also stripped. `accept-encoding` is forced to `identity` to prevent compressed responses that can't be rewritten for HTML injection.

### PASS -- Response header sanitization

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:35-53, 157-179`
- **Detail**: `stripProxyResponseHeaders()` removes hop-by-hop headers, `content-encoding`, `set-cookie`/`set-cookie2`, `authorization`, and all security policy headers (`content-security-policy`, `x-frame-options`, `referrer-policy`, `permissions-policy`). This prevents the upstream sandbox from overriding the proxy's security headers. The proxy applies its own CSP, X-Frame-Options, and Referrer-Policy.

### PASS -- Content-Security-Policy on injected HTML pages

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:181-211`
- **Detail**: `buildTokenHtmlHeaders()` sets a CSP that restricts `connect-src` to `'self'`, the sandbox origin (HTTPS and WSS), and the proxy origin. `default-src` is `'self' 'unsafe-inline'`. `form-action` and `base-uri` are locked to `'self'`. `img-src` allows `data:` and `blob:` for OpenClaw's image handling. `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` are also set. `Cache-Control: no-store, private` prevents caching of token-bearing pages.

### PASS -- Content-Security-Policy on waiting page

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:213-221`, `src/server/proxy/pending-response.ts:67`
- **Detail**: The waiting page gets its own CSP via `buildWaitingPageCsp()` that is tighter than the gateway CSP -- `connect-src 'self'` only, no sandbox origin. This is correct since the waiting page only polls `/api/status`.

### PASS -- Waiting page HTML escaping

- **Evidence**: `src/server/proxy/waitingPage.ts:156-173`
- **Detail**: Both `returnPath` and the status label are passed through `escapeHtml()` which replaces `<`, `>`, `&`, `"`, and `'`. The escaped values are used in the `<title>`, `<h1>`, and `data-return-path` attribute. The polling script reads `returnPath` from the DOM attribute via `getAttribute()` and passes it to `location.replace()`, not `innerHTML`, so there is no XSS vector.

### PASS -- Query parameter sanitization

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:98-107`
- **Detail**: `sanitizeProxyQueryParams()` strips any parameter starting with `_` (internal params) and any named `token` or `authorization` (case-insensitive). This prevents credential leakage through query strings forwarded to the sandbox.

### PASS -- Domain normalization rejects IP addresses

- **Evidence**: `src/server/firewall/domains.ts:63-64`
- **Detail**: `normalizeDomain()` explicitly rejects IP addresses via `isIP()` check. The firewall allowlist is domain-only, which means IP-based egress bypasses the firewall entirely. This is a known and documented limitation (see `state.ts:625`), but it is the correct behavior for the domain-based firewall model -- the Vercel Sandbox `NetworkPolicy` is the enforcement point, and the app only manages the domain list.

### PASS -- Firewall mode transitions are guarded

- **Evidence**: `src/server/firewall/state.ts:53-66, 159-172, 196-208`
- **Detail**: Switching to `enforcing` with an empty allowlist is blocked with a 409 error. Removing all domains while in `enforcing` mode is also blocked. The `promoteLearnedDomainsToEnforcing` function checks the merged allowlist size before enabling enforcement. These guards prevent accidental lockout.

### PASS -- Firewall policy mapping is correct

- **Evidence**: `src/server/firewall/policy.ts:7-18`
- **Detail**: `toNetworkPolicy()` maps `enforcing` to `{ allow: [...] }`, and both `disabled` and `learning` to `allow-all`. The `switch` is exhaustive over the three mode values with no default fallthrough. The allowlist is sorted for deterministic policy hashing.

### WARN -- `unsafe-inline` in CSP default-src

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:196-197`
- **Detail**: The CSP includes `default-src 'self' 'unsafe-inline'`, which is necessary because the proxy injects an inline `<script>` for WebSocket rewriting and heartbeat. The injected script cannot use a nonce because the proxy rewrites upstream HTML and cannot predict which inline scripts the OpenClaw UI already contains.
- **Severity**: Low
- **Recommended fix**: This is an acceptable trade-off for the proxy architecture. The injected script is generated server-side with proper escaping, and the CSP restricts `connect-src` to known origins. If OpenClaw's UI were to adopt CSP nonces in the future, the proxy could propagate them. No action required.

### WARN -- Redirect-blocked HTML response does not escape proxyOrigin

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:220-222`
- **Detail**: The protocol-relative redirect block returns HTML with `proxyOrigin` interpolated into an `href` attribute: `<a href="${proxyOrigin}">Return</a>`. The `proxyOrigin` is derived from `new URL(request.url).origin`, which for valid HTTP requests always produces a scheme+host string (e.g., `https://example.com`) that cannot contain HTML metacharacters. However, it would be more defensively correct to escape this value.
- **Severity**: Low (no exploitable vector since `URL.origin` cannot produce `<`, `>`, `"`, or `&` in a well-formed origin)
- **Recommended fix**: Apply HTML escaping to `proxyOrigin` in the redirect-blocked response for defense in depth. The risk is effectively zero given the `new URL()` construction, but escaping costs nothing.

### WARN -- Firewall learning relies on shell log observation, not network inspection

- **Evidence**: `src/server/firewall/state.ts:619-625`, `src/server/firewall/domains.ts:115-181`
- **Detail**: Domain learning is based on parsing shell command logs written to `/tmp/shell-commands-for-learning.log`. This misses: background daemons that don't log to the file, IP-only connections, DNS-over-HTTPS, and domains accessed by processes that bypass the shell hook. The code documents these limitations explicitly in `FIREWALL_LIMITATIONS` and surfaces them in the firewall report.
- **Severity**: Low (documented and inherent to the design; the Vercel Sandbox `NetworkPolicy` is the actual enforcement point)
- **Recommended fix**: No code change needed. The limitations are well-documented. Operators should understand that `learning` mode provides a best-effort domain inventory, not a complete traffic audit.

### WARN -- Learning log read-and-truncate is not atomic

- **Evidence**: `src/server/firewall/state.ts:410-413`
- **Detail**: The ingestion command `cat ${LEARNING_LOG_PATH}; : > ${LEARNING_LOG_PATH}` reads then truncates the file in a single shell invocation. If commands write to the log between the `cat` and the `: >`, those entries are lost. The distributed lock (`acquireLock` at line 400) prevents concurrent ingestion but does not synchronize with the shell hook writing to the file.
- **Severity**: Low (learning is best-effort and ingestion runs every 10 seconds; lost entries in a single cycle are likely recaptured in subsequent cycles)
- **Recommended fix**: Could use `mv` + `cat` + `rm` for more atomic reads, but the current approach is acceptable given the best-effort nature of learning.

### PASS -- WebSocket rewrite only targets same-origin and sandbox-origin connections

- **Evidence**: `src/server/proxy/htmlInjection.ts:144-184`
- **Detail**: The WebSocket constructor override only rewrites URLs whose host matches `window.location.host` (the proxy) or the sandbox origin host. All other WebSocket connections pass through unmodified. The gateway token is only appended to rewritten connections via the `openclaw.gateway-token.*` sub-protocol. This prevents token leakage to third-party WebSocket servers.

### PASS -- Bypass secret handling in public-url.ts

- **Evidence**: `src/server/public-url.ts:110-113, 221-249, 273-291`
- **Detail**: `getProtectionBypassSecret()` reads from `VERCEL_AUTOMATION_BYPASS_SECRET`. `buildPublicUrl()` appends the secret as a query parameter for outbound/delivery URLs only. `buildPublicDisplayUrl()` explicitly never includes the secret. Log output uses `sanitizeUrlForLogs()` (line 58-63) which redacts the bypass value. The separation between delivery URLs and display URLs is clean and consistently applied.

### PASS -- Secret redaction in learned domain context

- **Evidence**: `src/server/firewall/domains.ts:203-232, 256-259`
- **Detail**: `redactCommand()` strips environment variable assignments for known secret names, Bearer/Token/Basic auth headers, URL credentials, inline key/token/password flags, and long hex/base64 strings (including `sk-*`, `ghp_*`, `xoxb-*` prefixes). This is applied before persisting learned domain context in firewall events, preventing secret leakage into the store.

### PASS -- Domain normalization is thorough

- **Evidence**: `src/server/firewall/domains.ts:22-91`
- **Detail**: `normalizeDomain()` handles: control character rejection, Unicode dot normalization, URL scheme stripping, IDN to ASCII conversion via `domainToASCII()`, length limits (253 total, 63 per label), leading/trailing dot rejection, double-dot rejection, wildcard rejection, IP address rejection, label format validation (alphanumeric + hyphens, no leading/trailing hyphens), TLD validation, and ambiguous TLD filtering (`.js`, `.ts`, `.zip`, etc.). The `extractDomains()` function resets `lastIndex` on all global regexes before use, preventing stale state bugs.

## Issues Summary

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| W1 | Low | `unsafe-inline` required in CSP for injected script | Accepted (architectural constraint) |
| W2 | Low | Redirect-blocked HTML does not escape `proxyOrigin` | Cosmetic improvement possible |
| W3 | Low | Learning based on shell log observation, not network traffic | Documented limitation |
| W4 | Low | Learning log read-and-truncate has small race window | Acceptable for best-effort learning |

## Recommended Fixes (ranked by severity)

1. **W2 -- Escape proxyOrigin in redirect-blocked response** (`src/app/gateway/[[...path]]/route.ts:220`): Import and apply HTML escaping to the `proxyOrigin` value in the blocked-redirect response. Zero risk currently, but improves defense in depth.

No critical or high-severity issues found. The proxy and firewall implementation follows security best practices:
- Auth-before-proxy pattern is consistently applied
- Header sanitization uses allowlists, not blocklists, for forwarded headers
- Path traversal protection includes double-decode detection
- Gateway token is properly escaped in HTML and stripped from response headers
- CSP is applied to all HTML responses with appropriate restrictions
- Upstream redirects are blocked or rewritten to prevent open redirects
- WebSocket rewriting only targets known origins
- Secret values are redacted before persistence
