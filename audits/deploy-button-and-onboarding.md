# Deploy Button and Onboarding Audit

**Date**: 2026-04-03
**Auditor**: Pre-launch audit (Monday release gate)

## Scope

Files audited:

- `README.md` — deploy button URL, getting started instructions
- `vercel.json` — Vercel deployment config (cron, functions)
- `.env.example` — example env vars for first-time setup
- `docs/environment-variables.md` — full env var reference
- `CONTRIBUTING.md` — contributor env var docs
- `CLAUDE.md` — agent/dev instructions (env var table)
- `src/app/api/setup/route.ts` — bootstrap endpoint
- `src/app/api/setup/setup-security.test.ts` — bootstrap security tests
- `src/app/api/auth/login/route.ts` — login endpoint
- `src/server/auth/admin-auth.ts` — admin auth logic
- `src/server/auth/admin-secret.ts` — secret management
- `src/server/auth/session.ts` — session encryption
- `src/server/env.ts` — env var resolution, `getCronSecret()`, `getOpenclawPackageSpec()`
- `src/server/deploy-preflight.ts` — preflight checks
- `src/server/deployment-contract.ts` — deployment contract builder
- `src/app/api/admin/preflight/route.ts` — preflight API
- `src/app/api/admin/launch-verify/route.ts` — launch verification
- `src/app/api/cron/watchdog/route.ts` — cron auth
- `src/app/api/health/route.ts` — health endpoint
- `src/app/page.tsx` — root page (login or admin shell)
- `src/components/admin-shell.tsx` — admin UI (login form, tabs)

---

## Issues Summary

| ID   | Severity | Status | Summary |
|------|----------|--------|---------|
| DO-1 | P2       | RESOLVED | Docs now reflect the pinned runtime fallback `openclaw@2026.3.28` instead of `openclaw@latest` |
| DO-2 | P3       | RESOLVED | `cronSecretConfigured` intentionally reports explicit `CRON_SECRET` configuration only; fallback source is tracked separately by runtime/contract logic |
| DO-3 | P3       | WARN   | No minimum length enforcement on `ADMIN_SECRET` |
| DO-4 | P3       | RESOLVED | `docs/environment-variables.md` now documents `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` |
| DO-5 | P3       | PASS   | Deploy button `envDescription` references CRON_SECRET fallback (matches runtime) |
| DO-6 | P2       | RESOLVED | All operator-facing surfaces now agree: `CRON_SECRET` is recommended (not required) on Vercel when `ADMIN_SECRET` is set; deployment contract returns `warn` (not `fail`) |

---

## Findings

### PASS -- Deploy button URL is well-formed and correct

- **Evidence**: `README.md:14`
- Decoded URL: `https://vercel.com/new/clone?repository-url=https://github.com/vercel-labs/vercel-openclaw.git&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17&env=ADMIN_SECRET&envDescription=Password for the admin UI. Also used to secure cron jobs unless CRON_SECRET is set separately.&project-name=openclaw&repository-name=openclaw`
- `integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17` auto-provisions Upstash Redis (confirmed by README step 1 and `.env.example` comments)
- Only `ADMIN_SECRET` is prompted -- this is correct because:
  - Upstash is auto-provisioned by the integration
  - AI Gateway uses Vercel OIDC automatically on deployed environments
  - `CRON_SECRET` falls back to `ADMIN_SECRET` via `getCronSecretConfig()` (`src/server/env.ts:139-149`)
  - Public origin resolves from Vercel system env vars automatically
- `envDescription` correctly explains the CRON_SECRET fallback

### PASS -- Getting Started instructions match actual behavior

- **Evidence**: `README.md:25-31`
- Step 1 (Deploy): auto-provisions Upstash, asks for ADMIN_SECRET — confirmed
- Step 2 (Sign in): login form appears at `/` when unauthenticated (`src/components/admin-shell.tsx:455-502`)
- Step 3 (Use OpenClaw): `/gateway` proxy triggers sandbox create if needed; first boot ~1min, resume ~10s -- consistent with lifecycle code
- Step 4 (Verify): launch verification is destructive, correctly distinguished from preflight
- Step 5 (Connect channels): WhatsApp and Discord marked experimental -- matches code

### PASS -- Bootstrap endpoint (`/api/setup`) is sealed on Vercel deployments

- **Evidence**: `src/app/api/setup/route.ts:18-31`
- Returns HTTP 410 when any Vercel env var is detected (`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`)
- Regression tests in `src/app/api/setup/setup-security.test.ts` cover all four env var variants
- Test at line 126 verifies no 64-char hex secret leaks in response body
- Test at line 195 confirms `revealAdminSecretOnce` export does not exist (first-caller-wins pattern removed)

### PASS -- Login flow is secure

- **Evidence**: `src/app/api/auth/login/route.ts`, `src/server/auth/admin-auth.ts:150-171`
- Timing-safe comparison via `timingSafeEqual` (`admin-auth.ts:34-38`)
- Rate limiting at `src/app/api/auth/login/route.ts:9-20`
- CSRF enforcement on cookie-based mutation requests (`admin-auth.ts:101-111`)
- Encrypted JWT session cookie using AES-256-GCM via `jose` (`session.ts:35-44`)
- Session cookie: `httpOnly`, `sameSite: Lax`, `secure` when on HTTPS, 7-day expiry
- Password managers suppressed on login form (data-1p-ignore, data-lpignore)
- Auto-generated secrets use 32 bytes of `crypto.randomBytes` (`admin-secret.ts:7,37`)

### PASS -- Admin panel renders correct first-time state

- **Evidence**: `src/app/page.tsx:99-102`, `src/components/admin-shell.tsx:455-502`
- Without session cookie: `getInitialStatus()` returns null -> login form displayed
- After login: `fetchStatus()` fetches `/api/status` -> shows sandbox state, tabs appear
- Status polling: 2s during transitional states (`creating`, `setup`, `booting`, `restoring`), 5s otherwise
- Login form UI includes "Enter the admin secret configured for this deployment" helper text

### PASS -- Preflight checks cover all required config for deploy-button users

- **Evidence**: `src/server/deployment-contract.ts:343-384`, `src/server/deploy-preflight.ts:424-621`
- Checks: `public-origin`, `webhook-bypass`, `store`, `ai-gateway`, `openclaw-package-spec`, `auth-config`, `cron-secret`, `bootstrap-exposure`
- For a deploy-button user (ADMIN_SECRET set, Upstash auto-provisioned, OIDC from Vercel):
  - `public-origin`: pass (resolves from `VERCEL_PROJECT_PRODUCTION_URL`)
  - `store`: pass (Upstash provisioned)
  - `ai-gateway`: pass (OIDC available)
  - `cron-secret`: warn on Vercel when `CRON_SECRET` is unset and runtime falls back to `ADMIN_SECRET`; fail only if both are missing
  - `auth-config`: pass (admin-secret mode has no extra requirements)
  - `openclaw-package-spec`: warn (not set, but runtime has a pinned fallback)
  - `webhook-bypass`: pass or warn (diagnostic only, never blocks)
- `ok` is true when no checks are `fail` -- deploy-button users can still be launch-ready with non-blocking warnings like `cron-secret` and `openclaw-package-spec`

### PASS -- Launch verification correctly validates runtime readiness

- **Evidence**: `src/app/api/admin/launch-verify/route.ts:492-526`
- Supports safe and destructive modes
- Phases: `preflight`, `queuePing`, `ensureRunning`, `chatCompletions`, `wakeFromSleep`, `restorePrepared`
- Preflight failures block all runtime phases via `getLaunchVerifyBlocking()` (`deploy-preflight.ts:367-421`)
- Supports both JSON and NDJSON streaming for real-time progress in the admin UI
- Channel readiness is only true after destructive verification passes end-to-end

### PASS -- Cron watchdog auth works with deploy-button configuration

- **Evidence**: `src/app/api/cron/watchdog/route.ts:6-19`, `src/server/env.ts:139-149`
- `getCronSecretConfig()` returns `ADMIN_SECRET` when `CRON_SECRET` is unset
- Watchdog checks `Authorization: Bearer` or `x-cron-secret` header
- Vercel Cron sends the secret automatically for authenticated cron routes
- Schedule in `vercel.json`: `"0 8 * * *"` (daily at 8am UTC, Hobby-compatible)

### PASS -- Health endpoint is unauthenticated (correct for monitoring)

- **Evidence**: `src/app/api/health/route.ts:4-13`
- Returns `{ ok, authMode, storeBackend, status, hasSnapshot }` without auth
- Does not expose secrets or sensitive data
- Suitable for uptime monitoring tools

---

## Issues Detail

### DO-1 (P2/RESOLVED) -- Documentation now reflects pinned fallback

- **Evidence**:
  - `src/server/env.ts:298`: `const OPENCLAW_DEFAULT_PACKAGE_SPEC = "openclaw@2026.3.28";`
  - `docs/environment-variables.md`: updated to "falls back to a pinned known-good version (currently `openclaw@2026.3.28`)"
  - `CONTRIBUTING.md`: updated to "falls back to a pinned known-good version (currently `openclaw@2026.3.28`)"
  - `CLAUDE.md`: updated both line 155 (preflight description) and env var table to reference pinned fallback
  - `.env.example`: updated to reference pinned fallback
  - `scripts/check-verifier-contract.mjs`: updated comment to reference pinned fallback
- **Status**: RESOLVED. All operator-facing surfaces now agree the runtime falls back to a pinned known-good version, not `openclaw@latest`.

### DO-2 (P3/RESOLVED) -- `cronSecretConfigured` preflight field now uses `getCronSecretConfig()`

- **Evidence**:
  - `src/server/deploy-preflight.ts:490-493`: `const cronSecret = getCronSecretConfig(); const cronSecretConfigured = cronSecret.value !== null;`
  - `src/server/env.ts:139-149`: `getCronSecretConfig()` returns `{ value, source }` with source being `"cron-secret"`, `"admin-secret"`, or `"missing"`
  - `src/server/deployment-contract.ts:164-214`: `checkCronSecret()` returns `warn` (not `fail`) on Vercel when falling back to `ADMIN_SECRET`
- **Detail**: The preflight payload now exposes three cron-related fields via `getCronSecretConfig()`: `cronSecretConfigured` (effective — true when any secret is available), `cronSecretExplicitlyConfigured` (true only when `CRON_SECRET` is explicitly set), and `cronSecretSource` (`"cron-secret"`, `"admin-secret"`, or `"missing"`). This aligns preflight with the deployment contract's fallback semantics.
- **Impact**: None. Contract and preflight now agree on cron auth status.
- **Status**: RESOLVED. Preflight and contract are fully aligned on cron secret resolution.

### DO-3 (P3/WARN) -- No minimum length enforcement on ADMIN_SECRET

- **Evidence**:
  - `src/server/auth/admin-secret.ts:85`: `const envSecret = normalizeSecret(process.env.ADMIN_SECRET);`
  - `normalizeSecret()` at line 21-26 only checks for empty/whitespace
  - Deploy button `envDescription` says "Password for the admin UI" with no length guidance
- **Detail**: A user can deploy with `ADMIN_SECRET=a` and the system will accept it. The auto-generated fallback uses 32 bytes (64 hex chars), but the env-var path has no minimum. The Vercel deploy form does not enforce length either.
- **Impact**: Low -- this is a solo-developer tool, not a multi-tenant system. The timing-safe comparison and rate limiting mitigate brute-force risk. However, weak passwords on a public-facing admin panel are a preventable risk.
- **Fix (optional)**: Add a warning log when `ADMIN_SECRET` is shorter than 16 characters. Do not reject short secrets at runtime (would break existing deployments), but consider a preflight warning.

### DO-4 (P3/RESOLVED) -- Terminal tab env vars now documented

- **Evidence**:
  - `.env.example:71-73`: `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` documented
  - `docs/environment-variables.md`: "Terminal tab helpers" section added with both vars
- **Status**: RESOLVED. `docs/environment-variables.md` now has a dedicated "Terminal tab helpers" section documenting both variables.

### DO-6 (P2/RESOLVED) -- Cron-auth guidance is now consistent across all operator-facing surfaces

- **Decisive contract branch**: `src/server/deployment-contract.ts:164-214` — `checkCronSecret()` uses `getCronSecretConfig()` (env.ts:139-149) which resolves `CRON_SECRET` → `ADMIN_SECRET` → `missing`. On Vercel with `ADMIN_SECRET` set and `CRON_SECRET` unset, the contract returns **`warn`** (not `fail`). Only when both are missing does it return `fail`.
- **Evidence of alignment across all surfaces**:
  - `src/server/deployment-contract.ts:182-193`: `checkCronSecret()` returns `status: "warn"` when `cron.source === "admin-secret"` on Vercel — canonical source of truth
  - `CLAUDE.md:549`: "Recommended on Vercel … The deployment contract **warns** (not fails) on Vercel when only `ADMIN_SECRET` is available" — **matches contract**
  - `README.md:55-62`: scoped to "For the default deploy-button path (`VERCEL_AUTH_MODE=admin-secret`)" and describes fallback — **matches contract**
  - `docs/environment-variables.md:26`: "When unset, the runtime falls back to `ADMIN_SECRET`" — **matches contract**
  - `.env.example:55-58`: "Optional on Vercel. /api/cron/watchdog uses `CRON_SECRET` when set; otherwise it falls back to `ADMIN_SECRET`" — **matches contract**
  - `src/server/deploy-preflight.ts:490-493`: `cronSecretConfigured` uses `getCronSecretConfig()` — reflects effective cron auth, with `cronSecretExplicitlyConfigured` for explicit-only checks
- **Status**: RESOLVED. All five operator-facing surfaces (`CLAUDE.md`, `README.md`, `docs/environment-variables.md`, `.env.example`, and the deployment contract itself) now agree that `CRON_SECRET` is recommended but not required on Vercel when `ADMIN_SECRET` is set.

---

## Recommended Fixes (ranked by severity)

1. **P3 (DO-3)** -- Consider adding a preflight warning when `ADMIN_SECRET` is shorter than 16 characters. Not a launch blocker.

---

## Release Recommendation

**No launch blockers.** The deploy-button flow is correct and complete. Auth is secure. Preflight and launch verification catch all required config. DO-1 (package spec fallback docs), DO-2 (cron config field scope), DO-4 (terminal tab env vars), DO-5 (deploy button copy), and DO-6 (cron-auth consistency) are all resolved. The only remaining open item is DO-3 (admin secret minimum length), which is a low-priority hardening improvement.
