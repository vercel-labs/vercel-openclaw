# Proxy Injection Safety & Firewall Correctness Audit

**Date**: 2026-04-03
**Auditor**: Claude (automated)
**Scope**: HTML injection, proxy header/origin rewriting, waiting page, firewall domain classification, firewall policy evaluation

## Files Inspected

- `src/server/proxy/htmlInjection.ts` (226 lines)
- `src/server/proxy/proxy-route-utils.ts` (222 lines)
- `src/server/proxy/waitingPage.ts` (174 lines)
- `src/server/firewall/domains.ts` (309 lines)
- `src/server/firewall/policy.ts` (38 lines)
- `src/server/firewall/state.ts` (653 lines)
- `src/app/gateway/[[...path]]/route.ts` (338 lines)
- `src/server/proxy/htmlInjection.test.ts` (216 lines)
- `src/server/proxy/proxy-route-utils.test.ts` (65 lines)
- `src/server/firewall/domains.test.ts` (439 lines)
- `src/server/firewall/policy.test.ts` (113 lines)

---

## Findings

### PASS — XSS prevention in inline script injection

- **Evidence**: `src/server/proxy/htmlInjection.ts:9-21` — `escapeForInlineScriptJson()` escapes `<`, U+2028, U+2029 in JSON-serialized context before embedding into a `<script>` tag.
- **Why it matters**: Prevents `</script>` breakout attacks in the gateway token or sandbox origin. A malicious gateway token like `</script><script>alert(1)</script>` is neutralized by replacing `<` with `\u003c`.
- **Test coverage**: `htmlInjection.test.ts:57-74` explicitly tests `</script>` breakout with a crafted gateway token, asserting exactly one `<script>` open/close pair.
- **Verdict**: Sound. The escaping covers all three known inline-script JSON injection vectors.

### PASS — Waiting page HTML escaping

- **Evidence**: `src/server/proxy/waitingPage.ts:156-173` — `escapeHtml()` covers `<`, `>`, `&`, `"`, `'`.
- **Evidence**: `src/server/proxy/waitingPage.ts:22-23` — Both `returnPath` and status `label` are escaped before embedding in HTML.
- **Why it matters**: The waiting page embeds `returnPath` (derived from the request URL) in a `data-return-path` attribute and the label in `<h1>`. Without escaping, an attacker-controlled path could inject HTML.
- **Verdict**: Sound. All user-controlled values are escaped before insertion.

### PASS — Waiting page `returnPath` consumption is safe from open-redirect

- **Evidence**: `src/server/proxy/waitingPage.ts:108` — The inline script reads `data-return-path` and passes it to `location.replace()`.
- **Evidence**: `src/app/gateway/[[...path]]/route.ts:95` — `returnPath` is always constructed as `/gateway${path}`, which is a same-origin relative path.
- **Verdict**: The `returnPath` is always app-relative (starts with `/gateway`), so it cannot redirect to an external origin. No XSS or open-redirect risk.

### PASS — Proxy path traversal prevention

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:64-96` — `isInvalidProxyTargetPath()` blocks: backslashes, null bytes, encoded nulls (`%00`), encoded slashes (`%2f`, `%5c`), double-decode attacks (runs up to 2 decode rounds), and `.`/`..` path segments.
- **Evidence**: `src/app/gateway/[[...path]]/route.ts:81-83` — Invalid paths return 400 before any upstream fetch.
- **Test coverage**: `proxy-route-utils.test.ts:12-16` tests traversal and encoded slash attacks.
- **Verdict**: Defense-in-depth against path traversal is solid. Double-decode protection is a good hardening measure.

### PASS — Proxy header sanitization (request direction)

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:1-33` — Explicit allowlist of safe request headers. `cookie`, `authorization`, `origin`, `referer` are blocked. Hop-by-hop headers are stripped.
- **Evidence**: `src/server/proxy/proxy-route-utils.ts:143` — `accept-encoding` is forced to `identity` to prevent compressed responses the proxy can't rewrite.
- **Evidence**: `src/server/proxy/proxy-route-utils.ts:147-152` — Server-injected headers (the sandbox auth bearer token) are applied last, overriding anything a client might have smuggled.
- **Test coverage**: `proxy-route-utils.test.ts:34-51` verifies cookie and auth stripping.
- **Verdict**: Sound. The allowlist approach is safer than a blocklist.

### PASS — Proxy header sanitization (response direction)

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:35-53` — `STRIP_RESPONSE_HEADERS` removes `set-cookie`, `set-cookie2`, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, `authorization`, and all hop-by-hop headers from upstream responses.
- **Evidence**: `src/server/proxy/proxy-route-utils.ts:172-173` — Secret-value scanning: if any stripped header value contains a known secret string (gateway token), the entire header is dropped.
- **Why it matters**: Prevents the sandbox from setting cookies on the proxy origin, overriding security headers, or leaking the gateway token in response headers.
- **Test coverage**: `proxy-route-utils.test.ts:53-64` verifies set-cookie and CSP stripping.
- **Verdict**: Sound.

### PASS — Sensitive query param stripping

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:98-107` — `sanitizeProxyQueryParams()` strips `token`, `authorization`, and any `_`-prefixed params before forwarding to the sandbox.
- **Test coverage**: `proxy-route-utils.test.ts:18-27`.
- **Verdict**: Prevents accidental token forwarding to the sandbox in URL params.

### PASS — CSP on proxied HTML pages

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:181-211` — `buildTokenHtmlHeaders()` sets a restrictive CSP: `default-src 'self' 'unsafe-inline'`, `connect-src` limited to self/sandbox/proxy origins, `img-src` limited to self/data/blob, `form-action 'self'`, `base-uri 'self'`. Also sets `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store, private`.
- **Verdict**: Good defense-in-depth. The `base-uri 'self'` directive prevents the injected `<base>` tag from being overridden by sandbox HTML.

### PASS — Upstream redirect rewriting prevents open redirect

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:214-257` — Redirect handling:
  1. Protocol-relative redirects (`//...`) are blocked entirely (HTML response with "Redirect blocked").
  2. Absolute redirects to the sandbox host are rewritten to relative paths.
  3. Absolute redirects to other hosts are silently dropped (header removed).
  4. Relative redirects pass through unchanged.
- **Verdict**: Comprehensive. No path for an upstream redirect to send the browser to an attacker-controlled origin.

### PASS — Gateway token is confined to injected script and hash fragment

- **Evidence**: `src/server/proxy/htmlInjection.ts:196-202` — Token is passed to OpenClaw via URL hash fragment (never sent to servers). The fragment is set via `history.replaceState` and cleaned up by OpenClaw.
- **Evidence**: `src/server/proxy/htmlInjection.ts:24-33` — Token is embedded inside a JSON literal within a `<script>` block, never in HTML attributes, comments, or visible text.
- **Test coverage**: `htmlInjection.test.ts:103-152` — Two dedicated tests verify the token only appears within `<script>` boundaries and not in HTML comments or data attributes.
- **Verdict**: The token never leaks outside the script context or to external servers.

### PASS — Gateway auth enforced before HTML injection

- **Evidence**: `src/app/gateway/[[...path]]/route.ts:85-88` — `requireGatewayAuth()` runs before any upstream fetch or HTML injection. GET/HEAD/OPTIONS use read auth; all others use mutation auth (includes CSRF check).
- **Why it matters**: If auth were skipped, the gateway token embedded in HTML would leak to unauthenticated users.
- **Verdict**: Correct ordering.

### PASS — Firewall domain normalization is robust

- **Evidence**: `src/server/firewall/domains.ts:22-91` — `normalizeDomain()` handles: control characters, Unicode dots, URL schemes, auth-in-URL stripping, IDN via `domainToASCII()`, wildcard rejection, IP rejection, label length limits, TLD validation, ambiguous TLD filtering.
- **Test coverage**: `domains.test.ts` — 30+ test cases including env vars, JS patterns, npm output, bare domains, ambiguous TLDs, and IPs.
- **Verdict**: Thorough. The ambiguous TLD set (`get`, `js`, `json`, `log`, etc.) prevents false positives from file extensions.

### PASS — Firewall policy mapping is correct

- **Evidence**: `src/server/firewall/policy.ts:7-18` — `toNetworkPolicy()` maps `disabled`/`learning` to `allow-all` and `enforcing` to `{ allow: [...] }`. The allowlist is sorted and copied (no mutation of input).
- **Test coverage**: `policy.test.ts` — 12 tests covering all modes, empty allowlist, single domain, and input immutability.
- **Verdict**: Correct and well-tested.

### PASS — Enforcing mode with empty allowlist is blocked

- **Evidence**: `src/server/firewall/state.ts:53-66` — `setFirewallMode("enforcing")` throws `ApiError(409)` if the allowlist is empty.
- **Evidence**: `src/server/firewall/state.ts:159-172` — `removeDomains()` throws `ApiError(409)` if removal would empty the allowlist while enforcing.
- **Evidence**: `src/server/firewall/state.ts:196-206` — `promoteLearnedDomainsToEnforcing()` throws if the combined allowlist would be empty.
- **Verdict**: Prevents operators from accidentally blocking all network access.

### PASS — Secret redaction in firewall learning logs

- **Evidence**: `src/server/firewall/domains.ts:205-232` — `redactCommand()` strips: env var secrets, Bearer/Token/Basic auth, URL credentials, CLI flag secrets, and known token patterns (sk-*, ghp_*, xoxb-*, long hex/base64).
- **Evidence**: `src/server/firewall/domains.ts:256` — `extractDomainsWithContext()` applies `redactCommand()` to every source command before returning.
- **Test coverage**: `domains.test.ts:387-438` — 7 tests covering env vars, Bearer tokens, URL credentials, CLI flags, and round-trip through `extractDomainsWithContext`.
- **Verdict**: Best-effort redaction is appropriate for operator-visible logs. Not a security boundary but reduces accidental secret exposure.

### PASS — Firewall learning uses distributed lock

- **Evidence**: `src/server/firewall/state.ts:399-401` — `ingestLearningFromSandbox()` acquires a store lock before reading the shell log, preventing concurrent ingestion from racing on the same log file.
- **Verdict**: Correct for single-instance deployment.

### PASS — Waiting page CSP

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:213-221` — `buildWaitingPageCsp()` is restrictive: `default-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `img-src 'self' data:`, `form-action 'self'`, `base-uri 'self'`.
- **Verdict**: Appropriate for a minimal status-polling page.

---

### PASS — `unsafe-inline` in CSP is required (not a hardening gap)

- **Evidence**: `src/server/proxy/proxy-route-utils.ts:196` — `default-src 'self' 'unsafe-inline'` is used in the CSP for proxied HTML pages.
- **Evidence**: `src/server/proxy/htmlInjection.ts:207-213` — `injectIntoHead()` injects into the upstream HTML `<head>` but does not strip existing `<script>` tags from the proxied OpenClaw UI.
- **Evidence**: `src/server/proxy/proxy-route-utils.ts:49` — Upstream's own CSP is stripped from responses (`content-security-policy` is in `STRIP_RESPONSE_HEADERS`), so our CSP governs all scripts.
- **Why `unsafe-inline` is required**: The proxy serves the full OpenClaw web UI, which contains its own inline scripts. A nonce-based approach would require rewriting every `<script>` tag in upstream HTML to include the nonce — not feasible for a transparent proxy.
- **Mitigations in place**: (a) `connect-src` restricts fetch/WebSocket destinations to self + sandbox + proxy origins, (b) `form-action 'self'` prevents form-based exfiltration, (c) `base-uri 'self'` prevents base-tag hijacking, (d) `img-src 'self' data: blob:` limits image-based exfiltration.
- **Verdict**: Correct architectural choice. The CSP is as restrictive as possible given the proxy's requirement to execute upstream inline scripts.

### WARN — Firewall learning trusts shell command log text (P3 — documented limitation)

- **Evidence**: `src/server/firewall/state.ts:619-625` — The `FIREWALL_LIMITATIONS` array explicitly documents this: "Learning is based on shell command text observation, not actual network traffic inspection."
- **Why it matters**: A process that makes network calls without appearing in the shell log (background daemons, DNS-over-HTTPS, IP-only connections) would be missed.
- **Recommendation**: Already documented. No action needed for Monday release.

### WARN — No integration test for gateway route handler (P2 — test gap)

- **Evidence**: No test file exists at `src/app/gateway/[[...path]]/route.test.ts`.
- **Why it matters**: The gateway route handler (`route.ts`, 338 lines) contains the full proxy flow: auth check, sandbox ensure, token refresh, upstream fetch, redirect rewriting, HTML injection, and error handling. This is the highest-value code path with no dedicated integration test.
- **Recommendation**: Add integration tests for: (a) auth rejection, (b) pending/waiting-page flow, (c) 401 retry, (d) 410 reconciliation, (e) redirect blocking, (f) HTML injection trigger on `text/html` responses. Not a release blocker because the individual utilities are well-tested, but this is the top priority test gap.

### WARN — Double-encoded path traversal test coverage is minimal (P3 — test gap)

- **Evidence**: `proxy-route-utils.test.ts:12-16` — Only three path traversal cases are tested.
- **Why it matters**: The implementation (`isInvalidProxyTargetPath`) handles double-decode, backslash, null byte, and segment validation, but most of these branches have no explicit test case.
- **Recommendation**: Add test cases for: backslash paths, null bytes (`\0`), `%00` encoding, double-encoded `%252f`, `decodeURIComponent` throw, and `.` segments. Low severity because the implementation is defensive.

---

## Release Verdict

**Ship unchanged for Monday release.**

All critical security properties are sound:
- XSS prevention in HTML injection: solid escaping + test coverage
- Proxy header sanitization: allowlist-based, both directions covered
- Path traversal prevention: multi-layer defense with double-decode protection
- Token confinement: hash-fragment delivery, script-only embedding, secret scanning in response headers
- Auth-before-injection ordering: verified
- Redirect blocking: comprehensive (protocol-relative, cross-origin, same-host rewriting)
- Firewall policy correctness: all modes tested, empty-allowlist guard in place
- Domain normalization: robust with ambiguous-TLD filtering

No FAIL findings. The WARN items are hardening opportunities and test gaps that can be addressed post-launch.

### Recommended Post-Launch Improvements (by priority)

| Priority | Item | Effort |
|----------|------|--------|
| P2 | Add integration tests for `gateway/[[...path]]/route.ts` | Medium |
| P3 | Expand path traversal test vectors in `proxy-route-utils.test.ts` | Small |
