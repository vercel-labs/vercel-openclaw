# Auth & Session Security Audit

**Date**: 2026-04-03
**Scope**: Admin auth, session handling, CSRF enforcement, cookie properties, route-level protections

## Files Audited

- `src/server/auth/admin-auth.ts`
- `src/server/auth/session.ts`
- `src/server/auth/csrf.ts`
- `src/server/auth/route-auth.ts`
- `src/server/auth/admin-secret.ts`
- `src/server/auth/vercel-auth.ts`
- `src/server/auth/rate-limit.ts`
- `src/server/env.ts`
- `src/app/api/auth/login/route.ts`
- `src/app/api/auth/authorize/route.ts`
- `src/app/api/auth/callback/route.ts`
- `src/app/api/cron/watchdog/route.ts`

## Auth Mode x Route Family Matrix

| Route Family | Auth Guard | CSRF on Mutations | Notes |
|---|---|---|---|
| `/api/admin/*` (GET) | `requireJsonRouteAuth` | No (GET exempt) | |
| `/api/admin/*` (POST/PUT/DELETE) | `requireMutationAuth` or `requireJsonRouteAuth` | Yes (cookie path) | Bearer skips CSRF |
| `/api/status` (GET/POST) | `requireJsonRouteAuth` | Yes (POST via method check) | |
| `/api/firewall/*` (GET) | `requireJsonRouteAuth` | No | |
| `/api/firewall/*` (POST) | `requireJsonRouteAuth` or `requireMutationAuth` | Yes (cookie path) | |
| `/api/channels/*/webhook` | Platform signature validation | No (public endpoints) | Correct: no admin auth |
| `/api/channels/summary` | `requireJsonRouteAuth` | Yes (POST via method check) | |
| `/api/channels/slack/install` | `requireAdminAuth` | No CSRF on GET | |
| `/api/channels/slack/install/callback` | `requireAdminAuth` | No CSRF on GET | |
| `/api/cron/watchdog` | `CRON_SECRET` bearer/header | No | Uses `===` not timing-safe |
| `/api/auth/login` | Rate-limited, no prior auth | N/A | Public endpoint |
| `/api/auth/authorize` | None (initiates OAuth) | N/A | Public endpoint |
| `/api/auth/callback` | OAuth state cookie validation | N/A | Public endpoint |
| `/gateway/**` | `requireJsonRouteAuth` | Yes (POST via method check) | Token injection gated behind auth |
| `/api/debug/*` | `requireMutationAuth` or `requireJsonRouteAuth` | Yes (mutations) | |

## Findings

### FAIL — Cron watchdog uses non-timing-safe secret comparison

- **Evidence**: `src/app/api/cron/watchdog/route.ts:18` — `bearer === configured || headerSecret === configured`
- **Why it matters**: The `CRON_SECRET` comparison uses JavaScript `===` which is vulnerable to timing side-channel attacks. An attacker who can measure response times precisely could extract the secret byte-by-byte. The admin auth module correctly uses `timingSafeEqual` (`src/server/auth/admin-auth.ts:34-38`), but the cron route does not.
- **Severity**: P2 (low practical risk on Vercel due to network jitter, but inconsistent with the security posture of the rest of the codebase)
- **Recommended fix**: Replace `===` comparisons with `timingSafeStringEqual` from `node:crypto`, matching the pattern in `admin-auth.ts:34-38`.

### WARN — Session secret fallback chain in admin-secret mode

- **Evidence**: `src/server/env.ts:34-65` — `getSessionSecret()` derives from `UPSTASH_REDIS_REST_TOKEN` when `SESSION_SECRET` is unset in admin-secret mode
- **Why it matters**: If the Upstash token rotates (e.g. during a marketplace re-provision), all existing session cookies silently become invalid. The derivation prefix `openclaw-session-derived-` is static and predictable. This is acceptable for admin-secret mode (sessions are low-value since the admin secret itself is the credential), but operators may not realize their sessions are coupled to the Upstash token.
- **Severity**: P3 (informational; no security vulnerability, but operational surprise risk)
- **Recommended fix**: Document this coupling in the env var table. Optionally log a one-time warning when the derived path is used on Vercel deployments.

### WARN — Local dev uses static session secret

- **Evidence**: `src/server/env.ts:64` — `return "openclaw-single-local-session-secret-change-me"`
- **Why it matters**: In local development without `SESSION_SECRET` or Upstash, a hardcoded static secret is used. This is gated behind `!isProduction()` (line 58), so it cannot reach production. However, any local dev instance shares the same encryption key, meaning cookies are portable between local instances.
- **Severity**: P3 (local dev only; no production impact)
- **Recommended fix**: None required. Acceptable for development convenience.

### PASS — Bearer token auth uses timing-safe comparison

- **Evidence**: `src/server/auth/admin-auth.ts:34-38` — `timingSafeStringEqual` using `timingSafeEqual` from `node:crypto`
- **Details**: Both `requireAdminAuth` (line 90) and `requireAdminMutationAuth` (line 124) call `timingSafeStringEqual`. Buffer lengths are compared before `timingSafeEqual` to avoid the length-mismatch exception.

### PASS — CSRF enforcement is correct for cookie-based mutations

- **Evidence**: `src/server/auth/admin-auth.ts:112-145` — `requireAdminMutationAuth` checks bearer first (no CSRF needed), then enforces CSRF for cookie path
- **Details**: The CSRF check (`src/server/auth/csrf.ts:16-49`) runs before session validation on the cookie path. This means a cross-origin attacker cannot even reach the session check. Bearer token requests correctly skip CSRF since browsers do not auto-attach `Authorization` headers cross-origin.

### PASS — CSRF implementation is sound

- **Evidence**: `src/server/auth/csrf.ts:16-49`
- **Details**: Checks Origin header first (with proper normalization via `new URL().origin`), falls back to `X-Requested-With: XMLHttpRequest` custom header check. Origin takes precedence (line 23-35 runs before custom header check). GET/HEAD/OPTIONS are exempt (line 18). Cross-origin Origin with matching `X-Requested-With` is correctly rejected (Origin check runs first).

### PASS — Cookie attributes are correct

- **Evidence**: `src/server/auth/admin-auth.ts:162-168` and `src/server/auth/session.ts:57-77`
- **Details**: All session cookies set:
  - `HttpOnly: true` — prevents JavaScript access
  - `SameSite: Lax` — prevents cross-origin POST submissions
  - `Path: /` — scoped to entire app
  - `Max-Age: 604800` (7 days) for sessions, `300` (5 min) for OAuth state
  - `Secure` flag is conditional on `isSecureRequest()` — correctly set on HTTPS
- The `SameSite=Lax` policy provides defense-in-depth alongside the explicit CSRF checks.

### PASS — OAuth flow uses PKCE and nonce validation

- **Evidence**: `src/server/auth/vercel-auth.ts:114-161` (authorize) and `163-212` (callback)
- **Details**: 
  - PKCE with S256 code challenge (`codeVerifier` → SHA-256 → base64url)
  - OAuth state validated with timing-safe comparison (`vercel-auth.ts:178`)
  - Nonce verified against ID token claims (`vercel-auth.ts:405`)
  - OAuth context cookie encrypted and short-lived (5 min TTL)
  - State cookie cleared after callback

### PASS — Open redirect protection on `next` parameter

- **Evidence**: `src/server/auth/vercel-auth.ts:446-470` — `sanitizeNextPath`
- **Details**: Rejects non-`/`-prefixed paths, protocol-relative paths (`//evil.com`), backslash variants, percent-encoded bypass attempts, and control characters. Defaults to `/admin`.

### PASS — Login rate limiting

- **Evidence**: `src/server/auth/rate-limit.ts:44-89` and `src/app/api/auth/login/route.ts:9-11`
- **Details**: Sliding-window rate limiter (10 attempts per 15 minutes per IP). IP extracted from `X-Forwarded-For` (Vercel edge sets this). Returns `429` with `Retry-After` header. In-memory store is acceptable — not shared across instances but sufficient to slow automated brute-force per instance.

### PASS — Session encryption uses JWE (A256GCM)

- **Evidence**: `src/server/auth/session.ts:35-44`
- **Details**: Uses `jose` library with `dir` + `A256GCM` encryption. Key derived via SHA-256 of session secret. JWE includes `iat` and `exp` claims, so expired tokens are automatically rejected by `jwtDecrypt`.

### PASS — Gateway proxy gates HTML injection behind auth

- **Evidence**: Confirmed via test `auth-enforcement.test.ts:252-278` — unauthenticated gateway requests return 401, not proxied HTML with embedded gateway token.

### PASS — Corrupted cookies rejected gracefully

- **Evidence**: `src/server/auth/session.ts:46-55` — `decryptPayload` catches all errors and returns `null`
- **Details**: Tested in `auth-enforcement.test.ts:466-502` — corrupted admin cookies result in 401, not 500.

### PASS — Admin secret auto-generation is safe

- **Evidence**: `src/server/auth/admin-secret.ts:37` — `randomBytes(32).toString("hex")`
- **Details**: 256-bit random secret generated via `node:crypto`. Race condition on concurrent cold-starts handled by read-after-write verification (lines 44-51).

### PASS — Route auth sweep coverage is comprehensive

- **Evidence**: `src/app/api/auth/auth-enforcement.test.ts:603-787`
- **Details**: Tests sweep all admin GET routes and mutation routes for unauthenticated rejection. Covers GET (401), POST without bearer/CSRF (403), wrong bearer (401), valid bearer (200), corrupted cookie (401), and gateway token leak prevention.

## Test Coverage Assessment

| Area | Status | Notes |
|---|---|---|
| Bearer token auth (accept/reject) | Covered | `auth-enforcement.test.ts` |
| Cookie session auth (accept/reject/corrupt) | Covered | `auth-enforcement.test.ts`, `session.test.ts` |
| CSRF enforcement (origin match/mismatch, custom header) | Covered | `csrf.test.ts` (16 tests) |
| Cookie attributes (HttpOnly, Secure, SameSite, MaxAge) | Covered | `session.test.ts` |
| Login rate limiting | Covered | `auth-enforcement.test.ts` |
| Gateway token leak prevention | Covered | `auth-enforcement.test.ts` |
| Route auth sweep (all admin + firewall routes) | Covered | `auth-enforcement.test.ts` |
| OAuth flow (authorize, callback, state validation) | Partially covered | `vercel-auth.test.ts` exists but not fully audited |
| Session expiry/refresh | **Gap** | No test for expired session triggering refresh |
| Mixed auth ambiguity (bearer + cookie on same request) | **Gap** | No test for request carrying both bearer and cookie |
| Cron secret timing-safe comparison | **Gap** | No test; uses `===` |

## Recommended Fixes (by severity)

1. **P2** — Cron watchdog timing-safe secret comparison (`src/app/api/cron/watchdog/route.ts:18`)
2. **P3** — Document session secret derivation coupling to Upstash token
3. **P3** — Add test for session refresh on expiry
4. **P3** — Add test for mixed bearer + cookie request behavior

## Launch Readiness

**No launch-blocking auth or session risks identified.** The cron timing side-channel (P2) is the only code-level finding, and its practical exploitability on Vercel is very low due to network jitter masking timing differences. All other auth surfaces are well-implemented with proper cryptographic primitives, comprehensive CSRF protection, and thorough test coverage.
