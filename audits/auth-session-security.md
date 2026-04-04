# Auth & Session Security Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit
**Verdict**: WARN

## Scope

Files audited:

- `src/server/auth/admin-auth.ts`
- `src/server/auth/admin-secret.ts`
- `src/server/auth/session.ts`
- `src/server/auth/vercel-auth.ts`
- `src/server/auth/csrf.ts`
- `src/server/auth/rate-limit.ts`
- `src/server/auth/route-auth.ts`
- `src/server/env.ts` (getSessionSecret)
- `src/app/api/auth/login/route.ts`
- `src/app/api/auth/authorize/route.ts`
- `src/app/api/auth/callback/route.ts`
- `src/app/api/auth/signout/route.ts`
- `src/app/api/setup/route.ts`

## Findings

### PASS — Timing-safe secret comparison

- **Evidence**: `src/server/auth/admin-auth.ts:34-38`, `src/server/auth/vercel-auth.ts:476-483`
- **Detail**: Both `admin-auth.ts` and `vercel-auth.ts` define `timingSafeStringEqual()` using `node:crypto.timingSafeEqual` with a length pre-check. The admin secret comparison at login (line 157), bearer token validation (line 90), and OAuth state validation (line 178) all use this function. No timing oracle is present.

### PASS — Session cookies use HttpOnly, SameSite=Lax, path=/

- **Evidence**: `src/server/auth/admin-auth.ts:162-168`, `src/server/auth/session.ts:70-77`, `src/server/auth/session.ts:124-130`
- **Detail**: All session cookies (`openclaw_admin`, `openclaw_session`, `vercel_oauth_ctx`, `vercel_oauth_state`) are set with `httpOnly: true`, `sameSite: "Lax"`, and `path: "/"`. The `Secure` flag is conditional on `isSecureRequest()` which checks `x-forwarded-proto` or the URL scheme, so it is correctly applied on HTTPS deployments and skipped for localhost HTTP.

### PASS — Encrypted session payloads with JWE (A256GCM)

- **Evidence**: `src/server/auth/session.ts:39-43`
- **Detail**: Session cookies are encrypted using `jose` EncryptJWT with `alg: "dir"` and `enc: "A256GCM"`. The encryption key is derived via SHA-256 from the session secret (line 32). Payloads include `iat` and `exp` claims set by `setIssuedAt()` and `setExpirationTime()`. This prevents session forgery and provides confidentiality for stored access/refresh tokens. The 7-day expiry (lines 68, 161) is appropriate for an admin tool.

### PASS — Mutation auth only applies CSRF to session-cookie requests

- **Evidence**:
  - `src/server/auth/admin-auth.ts:69-120` centralizes bearer/session resolution in `resolveAdminCredential()`.
  - `src/server/auth/admin-auth.ts:88-98` returns `401 UNAUTHORIZED` when no admin session cookie is present, logging `auth.csrf_skipped_no_session_cookie`.
  - `src/server/auth/admin-auth.ts:101-111` calls `verifyCsrf(request)` only after confirming a session cookie is present.
  - `src/server/auth/admin-auth.ts:165-175` reuses the same resolver for mutation auth.
- **Detail**: Previously, `requireAdminMutationAuth()` called `verifyCsrf()` before checking for a session cookie, causing unauthenticated requests to receive 403 CSRF errors instead of 401 Unauthorized. The refactored `resolveAdminCredential()` now checks cookie presence first, returning 401 for cookieless requests and only enforcing CSRF when a session cookie is actually present. Bearer requests still correctly skip CSRF.

### PASS — Bearer token path skips CSRF correctly

- **Evidence**: `src/server/auth/admin-auth.ts:87-95`, `src/server/auth/admin-auth.ts:122-129`
- **Detail**: Bearer token authentication bypasses CSRF. This is correct: the `Authorization` header is never sent automatically by browsers in cross-origin requests, so it cannot be exploited via CSRF.

### PASS — OAuth PKCE with S256 code challenge

- **Evidence**: `src/server/auth/vercel-auth.ts:123-135`
- **Detail**: The OAuth flow uses PKCE with `code_challenge_method: "S256"` and a 32-byte random code verifier. The verifier is stored in an encrypted, short-lived (5-minute) cookie. This prevents authorization code interception attacks.

### PASS — OAuth state parameter with timing-safe validation

- **Evidence**: `src/server/auth/vercel-auth.ts:121,178`
- **Detail**: A 24-byte random `state` parameter is generated, stored in a cookie, and validated with `timingSafeStringEqual()` in the callback. This prevents CSRF on the OAuth callback.

### PASS — Nonce validation on ID token

- **Evidence**: `src/server/auth/vercel-auth.ts:391-415`
- **Detail**: The ID token is verified against Vercel's JWKS with issuer and audience checks (line 395-398). When an expected nonce is provided (initial login flow), it is validated against the token claim (line 405). On refresh, the nonce is not re-checked (correct, since refresh tokens do not always return new ID tokens with nonces).

### PASS — Open redirect prevention in next-path sanitization

- **Evidence**: `src/server/auth/vercel-auth.ts:446-470`
- **Detail**: `sanitizeNextPath()` rejects non-`/`-prefixed paths, protocol-relative URLs (`//` or `/\`), and control characters. Both raw and percent-decoded forms are checked. This prevents open-redirect attacks via the `next` parameter.

### PASS — Login rate limiting

- **Evidence**: `src/app/api/auth/login/route.ts:9-10`, `src/server/auth/rate-limit.ts:44-89`
- **Detail**: The login endpoint enforces a sliding-window rate limit (10 attempts per 15-minute window per caller IP). Proper `Retry-After` headers are returned. The rate limiter is in-memory (per-instance), which is acknowledged and acceptable for this single-instance app.

### PASS — Setup endpoint sealed on Vercel

- **Evidence**: `src/app/api/setup/route.ts:18-32`
- **Detail**: `/api/setup` returns 410 Gone on Vercel deployments. In local dev, the auto-generated secret is revealed (line 60), which is intentional and documented. The generated secret is never exposed in production.

### PASS — Token refresh deduplication

- **Evidence**: `src/server/auth/vercel-auth.ts:226-245`
- **Detail**: Concurrent refresh requests for the same user (`sub`) are coalesced via a promise map. This prevents token refresh storms. On refresh failure, the session is cleared and the user is forced to re-authenticate (lines 93-101).

### PASS — Session secret enforcement in production

- **Evidence**: `src/server/env.ts:44-48`, `src/server/env.ts:58-62`
- **Detail**: `getSessionSecret()` throws if `SESSION_SECRET` is missing in deployed `sign-in-with-vercel` mode. In production without Upstash, it also throws. The local-dev fallback string (`"openclaw-single-local-session-secret-change-me"`) is only used outside production.

### PASS — Admin secret auto-generation uses sufficient entropy

- **Evidence**: `src/server/auth/admin-secret.ts:7,37`
- **Detail**: Auto-generated admin secrets use `randomBytes(32)` (256 bits of entropy) converted to hex. This exceeds the minimum for brute-force resistance.

### PASS — Route-auth layer correctly dispatches mutation vs read auth

- **Evidence**: `src/server/auth/route-auth.ts:13-24`
- **Detail**: `requireJsonRouteAuth()` dispatches to `requireAdminMutationAuth()` for non-GET/HEAD/OPTIONS methods and `requireAdminAuth()` for reads. This ensures CSRF is always checked for mutations going through the JSON route auth path.

### WARN — Signout via GET without CSRF protection

- **Evidence**: `src/app/api/auth/signout/route.ts:1-4`, `src/server/auth/vercel-auth.ts:214-224`
- **Detail**: The signout endpoint is `GET /api/auth/signout` with no authentication or CSRF check. An attacker can force a victim to sign out by embedding `<img src="/api/auth/signout">` on any page the victim visits. While this is a logout-CSRF issue (low severity since it only causes session destruction, not privilege escalation), it could be used as a denial-of-service nuisance against operators.
- **Severity**: Low
- **Recommended fix**: Change to POST with CSRF verification, or accept the risk since this is a single-operator admin tool where cross-site logout has minimal impact.

### WARN — No minimum length enforcement on ADMIN_SECRET env var

- **Evidence**: `src/server/auth/admin-secret.ts:20-26`
- **Detail**: `normalizeSecret()` only checks that the trimmed value is non-empty. An operator could set `ADMIN_SECRET=a` (1 character) and the system would accept it. There is no entropy or minimum-length validation. The deployment contract and preflight do not warn about weak secrets.
- **Severity**: Low
- **Recommended fix**: Add a minimum length check (e.g., 16 characters) in `getConfiguredAdminSecret()` or in the preflight/deployment-contract checks, and log a warning if the secret is below the threshold.

### WARN — Session secret derived from Upstash token in admin-secret mode on Vercel

- **Evidence**: `src/server/env.ts:50-56`
- **Detail**: When `SESSION_SECRET` is not set and auth mode is `admin-secret` on Vercel, the session encryption key is derived as `"openclaw-session-derived-" + upstashToken`. While the Upstash token has sufficient entropy, this derivation means: (1) anyone with access to the Upstash token can forge session cookies, and (2) rotating the Upstash token invalidates all sessions. This is a coupling risk rather than a vulnerability, since the Upstash token is already a high-privilege secret. The `sign-in-with-vercel` mode correctly requires an explicit `SESSION_SECRET`.
- **Severity**: Low
- **Recommended fix**: Consider warning in preflight when `SESSION_SECRET` is not explicitly set on Vercel, even in admin-secret mode, to encourage explicit secret management.

### WARN — In-memory rate limiter resets on cold start

- **Evidence**: `src/server/auth/rate-limit.ts:15-16`
- **Detail**: The rate limiter uses an in-memory `Map` that resets on every cold start. On Vercel, function instances are ephemeral. An attacker could trigger cold starts (by waiting for idle timeout or hitting different regions) to reset the rate limit window and continue brute-forcing. For a single-instance admin tool with a 256-bit auto-generated secret this is not exploitable in practice, but if operators set weak `ADMIN_SECRET` values, the rate limiter provides less protection than expected.
- **Severity**: Low
- **Recommended fix**: Accept the risk for this architecture. A store-backed rate limiter (Upstash) would be more robust but adds complexity for minimal gain given the threat model.

### PASS — No session fixation risk

- **Evidence**: `src/server/auth/admin-auth.ts:150-171`, `src/server/auth/vercel-auth.ts:196-211`
- **Detail**: Both login paths (admin-secret and OAuth callback) issue a new encrypted session token on successful authentication. The admin session is a fresh `{ admin: true }` payload; the OAuth session contains new tokens from the provider. Old session cookies are not reused. The OAuth flow also clears the state and context cookies after use (lines 205-206).

### PASS — No replay attack vector in encrypted sessions

- **Evidence**: `src/server/auth/session.ts:39-43`
- **Detail**: JWE tokens include `iat` (issued-at) and `exp` (expiration) claims. While there is no server-side session revocation store (which would enable instant invalidation), the encrypted tokens cannot be tampered with, and they expire after 7 days. For a single-operator admin tool, this is appropriate. The signout flow clears cookies client-side (line 219-222).

### PASS — Cookie parsing handles edge cases

- **Evidence**: `src/server/auth/session.ts:181-196`
- **Detail**: `getCookieValue()` splits on `;`, then on `=` (with `...valueParts` to handle values containing `=`), and uses `decodeURIComponent`. This correctly handles base64url-encoded JWE tokens that may contain `=` characters.

## Issues Summary

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| W1 | Low | GET-based signout without CSRF protection | Open |
| W2 | Low | No minimum length enforcement on ADMIN_SECRET | Open |
| W3 | Low | Session secret silently derived from Upstash token on Vercel (admin-secret mode) | Open |
| W4 | Low | In-memory rate limiter resets on cold start | Accepted |

## Recommended Fixes (ranked by severity)

1. **W2 — Enforce minimum ADMIN_SECRET length**: Add a check in `getConfiguredAdminSecret()` or the deployment contract that warns when `ADMIN_SECRET` is fewer than 16 characters. This catches misconfiguration before it becomes a security issue.

2. **W3 — Warn when SESSION_SECRET is not set on Vercel**: Add a preflight warning (not failure) when `SESSION_SECRET` is not explicitly configured on Vercel in admin-secret mode. This surfaces the implicit derivation to operators.

3. **W1 — Consider POST-based signout**: Change `/api/auth/signout` from GET to POST with CSRF enforcement. This follows the OWASP recommendation against GET-based logout. Low priority because this is a single-operator tool and the impact is limited to forced logout.

4. **W4 — Accept in-memory rate limiter**: Document the cold-start reset behavior. The threat model (single operator, high-entropy auto-generated secrets) makes this acceptable. Only revisit if weak user-provided secrets become common.

## Architecture Notes

The auth system is well-structured with clear separation of concerns:

- **Two auth modes** (admin-secret, sign-in-with-vercel) are cleanly separated
- **Three auth check layers**: `requireAdminAuth` (read), `requireAdminMutationAuth` (write + CSRF), `requireRouteAuth` (Vercel OAuth)
- **Cookie encryption** uses industry-standard JWE (A256GCM via jose library)
- **CSRF defense** uses dual Origin + custom-header verification
- **OAuth flow** implements PKCE, state, and nonce correctly
- **Secret handling** uses timing-safe comparison throughout

No critical or high-severity issues were found. The four warnings are all low-severity configuration/defense-in-depth items appropriate for a single-operator admin tool.
