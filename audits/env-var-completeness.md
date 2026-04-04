# Environment Variable Completeness Audit

**Date**: 2026-04-03
**Auditor**: Pre-launch deep audit
**Supersedes**: Previous env-var-completeness audit (same date, shallow pass)

## Scope

Files audited:

- `.env.example` — operator-facing env var template
- `docs/environment-variables.md` — canonical env var reference
- `README.md` — quick-start env var docs
- `CLAUDE.md` — contributor env var table (lines 547-561) and prose references
- `CONTRIBUTING.md` — contributor env var table (lines 140-158)
- `src/server/env.ts` — centralized env var access
- `src/server/deployment-contract.ts` — deployment contract checks
- `src/server/deploy-preflight.ts` — preflight checks
- `src/server/auth/admin-secret.ts` — ADMIN_SECRET handling
- `src/server/auth/debug-guard.ts` — ENABLE_DEBUG_ROUTES handling
- `src/server/sandbox/hot-spare.ts` — OPENCLAW_HOT_SPARE_ENABLED handling
- `src/server/sandbox/timeout.ts` — OPENCLAW_SANDBOX_SLEEP_AFTER_MS handling
- `src/server/sandbox/resources.ts` — OPENCLAW_SANDBOX_VCPUS handling
- `src/server/openclaw/config.ts` — OPENCLAW_OWNER_ALLOW_FROM handling
- `src/server/public-url.ts` — public URL resolution env vars
- `src/server/launch-verify/state.ts` — VERCEL_DEPLOYMENT_ID/VERCEL_GIT_COMMIT_SHA
- `src/app/api/debug/sandbox-timing/route.ts` — DEBUG_SANDBOX_SNAPSHOT_ID
- `scripts/check-verifier-contract.mjs` — automated env surface checker
- All `process.env.*` references across `src/` (39 unique env var names)

## Complete Env Var Inventory

### All `process.env.*` references in source code (non-test files)

| Variable | Category | .env.example | docs/env-vars.md | CLAUDE.md table | CONTRIBUTING.md | Deployment Contract |
|---|---|---|---|---|---|---|
| `ADMIN_SECRET` | Auth | -- | Yes | -- (prose only) | Yes | -- |
| `AI_GATEWAY_API_KEY` | AI Gateway | Commented | Yes | -- (prose only) | Yes | -- |
| `BASE_DOMAIN` | URL | Commented | Yes | -- | Yes | Yes |
| `CRON_SECRET` | Cron | Commented | Yes | Yes | Yes | Yes |
| `DEBUG_SANDBOX_SNAPSHOT_ID` | Debug | -- | -- | -- | -- | -- |
| `ENABLE_DEBUG_ROUTES` | Debug | -- | -- | -- | -- | -- |
| `KV_REST_API_TOKEN` | Store | Commented | Yes | -- | Yes | -- |
| `KV_REST_API_URL` | Store | Commented | Yes | -- | Yes | -- |
| `NEXT_PUBLIC_APP_URL` | URL | Commented | Yes | -- | Yes | Yes |
| `NEXT_PUBLIC_BASE_DOMAIN` | URL | Commented | Yes | -- | Yes | Yes |
| `NEXT_PUBLIC_SANDBOX_PROJECT` | UI | Commented | -- | -- | -- | -- |
| `NEXT_PUBLIC_SANDBOX_SCOPE` | UI | Commented | -- | -- | -- | -- |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | Auth | Yes | Yes | Yes | Yes | Yes |
| `NODE_ENV` | System | -- | -- | -- | -- | -- |
| `OPENCLAW_HOT_SPARE_ENABLED` | Experimental | -- | -- | -- | -- | -- |
| `OPENCLAW_INSTANCE_ID` | Store | Commented | Yes | Yes | Yes | -- |
| `OPENCLAW_OWNER_ALLOW_FROM` | Config | -- | -- | -- | -- | -- |
| `OPENCLAW_PACKAGE_SPEC` | Sandbox | Commented | Yes | Yes | Yes | Yes |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | Sandbox | Commented | Yes | Yes | Yes | -- |
| `OPENCLAW_SANDBOX_VCPUS` | Sandbox | Commented | Yes | Yes | Yes | -- |
| `SESSION_SECRET` | Auth | Yes | Yes | Yes | Yes | Yes |
| `SLACK_CLIENT_ID` | Channel | Commented | Yes | Yes | -- (route ref) | -- |
| `SLACK_CLIENT_SECRET` | Channel | Commented | Yes | Yes | -- (route ref) | -- |
| `SLACK_SIGNING_SECRET` | Channel | Commented | Yes | Yes | -- (route ref) | -- |
| `SMOKE_AUTH_COOKIE` | Testing | -- | -- | -- (prose) | -- | -- |
| `UPSTASH_REDIS_REST_TOKEN` | Store | Yes | Yes | Yes | Yes | Yes |
| `UPSTASH_REDIS_REST_URL` | Store | Yes | Yes | Yes | Yes | Yes |
| `VERCEL` | System | -- | -- | -- | -- | -- |
| `VERCEL_APP_CLIENT_SECRET` | Auth | Yes | Yes | Yes | Yes | Yes |
| `VERCEL_AUTH_MODE` | Auth | Commented | Yes | -- (prose) | Yes | -- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Protection | Commented | Yes | -- | Yes | Yes |
| `VERCEL_BRANCH_URL` | System | -- | -- | -- | -- | Excluded |
| `VERCEL_DEPLOYMENT_ID` | System | -- | -- | -- | -- | -- |
| `VERCEL_ENV` | System | -- | -- | -- | -- | -- |
| `VERCEL_GIT_COMMIT_SHA` | System | -- | -- | -- | -- | -- |
| `VERCEL_OIDC_TOKEN` | System | -- | -- | -- | -- | -- |
| `VERCEL_PROJECT_ID` | System | -- | -- | -- | -- | -- |
| `VERCEL_PROJECT_PRODUCTION_URL` | System | -- | -- | -- | -- | Excluded |
| `VERCEL_URL` | System | -- | -- | -- | -- | Excluded |

## Issues Summary

| ID | Severity | Status | Title |
|---|---|---|---|
| EV-1 | P2 | FIXED | OPENCLAW_PACKAGE_SPEC fallback docs previously said `openclaw@latest` — now corrected to `openclaw@2026.3.28` |
| EV-2 | P2 | WARN | `ADMIN_SECRET` missing from `.env.example` and CLAUDE.md env var table |
| EV-3 | P3 | WARN | `AI_GATEWAY_API_KEY` and `VERCEL_AUTH_MODE` missing from CLAUDE.md env var table |
| EV-4 | P3 | WARN | `OPENCLAW_OWNER_ALLOW_FROM` undocumented everywhere |
| EV-5 | P3 | WARN | Debug/experimental vars undocumented (ENABLE_DEBUG_ROUTES, DEBUG_SANDBOX_SNAPSHOT_ID, OPENCLAW_HOT_SPARE_ENABLED) |
| EV-6 | P3 | WARN | `NEXT_PUBLIC_SANDBOX_SCOPE`/`PROJECT` missing from docs/environment-variables.md |
| EV-7 | P3 | WARN | `KV_REST_API_*` aliases missing from CLAUDE.md env var table |
| EV-8 | P1 | PASS | No secrets exposed via NEXT_PUBLIC_ prefix |
| EV-9 | P1 | PASS | Deployment contract checker passes for all tracked vars |
| EV-10 | P1 | PASS | Default values are safe (session secret throws in production, admin secret auto-generates) |
| EV-11 | P2 | WARN | Verifier contract does not track `ADMIN_SECRET` or `AI_GATEWAY_API_KEY` |
| EV-12 | Medium | FIXED | Missing `OPENCLAW_PACKAGE_SPEC` on Vercel is documented as warn-only, but the contract previously passed |

## Detailed Findings

### EV-1 [P2/FIXED] — OPENCLAW_PACKAGE_SPEC fallback documentation drift

The runtime default changed from `openclaw@latest` to a pinned version `openclaw@2026.3.28` in `src/server/env.ts:298`, but documentation previously claimed the fallback was `openclaw@latest`.

**Status**: Fixed. All operator-facing documentation surfaces now correctly describe the pinned fallback:
- `CLAUDE.md:555` — "falls back to a pinned known-good version (currently `openclaw@2026.3.28`)"
- `CONTRIBUTING.md:150` — "falls back to a pinned known-good version (currently `openclaw@2026.3.28`)"
- `docs/environment-variables.md:44` — "falls back to a pinned known-good version (currently `openclaw@2026.3.28`)"
- `.env.example:34` — "(currently openclaw@2026.3.28)"

**Remaining `openclaw@latest` references** are legitimate — test cases for unpinned spec detection, benchmark scripts, and code comments explaining why the fallback is *not* `@latest`.

---

### EV-2 [P2/WARN] — ADMIN_SECRET missing from .env.example and CLAUDE.md env var table

`ADMIN_SECRET` is the single most important operator variable (README says "The only required variable is `ADMIN_SECRET`"), yet:

- `.env.example` does not include it at all (not even commented)
- `CLAUDE.md` env var table (lines 547-561) does not list it
- The deploy button prompts for it, README documents it, CONTRIBUTING.md documents it, and `docs/environment-variables.md` documents it

**Code evidence:** `src/server/auth/admin-secret.ts:85` reads `process.env.ADMIN_SECRET`.

**Impact:** An operator who copies `.env.example` for local dev gets no prompt to set `ADMIN_SECRET`. The auto-generation fallback mitigates this for local dev, but it is confusing that the "only required variable" is absent from the example file.

**Fix:** Add `ADMIN_SECRET=` as the first entry in `.env.example` with a comment explaining it is required on Vercel and auto-generated locally. Add to CLAUDE.md env var table.

---

### EV-3 [P3/WARN] — AI_GATEWAY_API_KEY and VERCEL_AUTH_MODE missing from CLAUDE.md env var table

Both vars appear in `.env.example`, `docs/environment-variables.md`, and `CONTRIBUTING.md`, but are only mentioned in prose (not the table) in `CLAUDE.md`.

- `AI_GATEWAY_API_KEY`: referenced at `CLAUDE.md:541,605` in prose but not in the table at lines 547-561
- `VERCEL_AUTH_MODE`: referenced at `CLAUDE.md:472` in prose but not in the table

**Impact:** Contributors referencing only the CLAUDE.md table miss these vars. Low severity because the prose sections cover them.

---

### EV-4 [P3/WARN] — OPENCLAW_OWNER_ALLOW_FROM undocumented everywhere

Used at `src/server/openclaw/config.ts:351` to restrict owner-level tool access to specific Telegram chat IDs or Slack user IDs. Not documented in any file: `.env.example`, README, CLAUDE.md, CONTRIBUTING.md, or `docs/environment-variables.md`.

**Impact:** Operators who want to restrict elevated access to specific senders have no way to discover this variable. Security-adjacent but the default ("*" = all senders) is intentional since the proxy enforces auth.

---

### EV-5 [P3/WARN] — Debug/experimental vars undocumented

| Variable | Location | Purpose |
|---|---|---|
| `ENABLE_DEBUG_ROUTES` | `src/server/auth/debug-guard.ts:13` | Gates access to `/api/debug/*` routes |
| `DEBUG_SANDBOX_SNAPSHOT_ID` | `src/app/api/debug/sandbox-timing/route.ts:13` | Default snapshot ID for timing debug route |
| `OPENCLAW_HOT_SPARE_ENABLED` | `src/server/sandbox/hot-spare.ts:27` | Feature flag for hot-spare sandbox prototype |

None appear in any documentation. These are internal/experimental and not needed for launch, but should be documented in CONTRIBUTING.md for contributor awareness.

---

### EV-6 [P3/WARN] — NEXT_PUBLIC_SANDBOX_SCOPE/PROJECT missing from docs

Both appear in `.env.example:72-73` and `CLAUDE.md` prose (admin UI section), but are absent from `docs/environment-variables.md` and `CONTRIBUTING.md`. Cosmetic UI hint variables only.

---

### EV-7 [P3/WARN] — KV_REST_API_* aliases missing from CLAUDE.md env var table

`KV_REST_API_URL` and `KV_REST_API_TOKEN` are documented in `.env.example`, `docs/environment-variables.md`, and `CONTRIBUTING.md`, but not in the CLAUDE.md env var table. These are alternative Upstash-compatible aliases used in `src/server/env.ts:88-89`.

---

### EV-8 [P1/PASS] — No secrets exposed via NEXT_PUBLIC_ prefix

All `NEXT_PUBLIC_*` variables are safe for client exposure:

- `NEXT_PUBLIC_APP_URL` — public origin, no secret
- `NEXT_PUBLIC_BASE_DOMAIN` — public hostname, no secret
- `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` — OAuth client ID (public by design)
- `NEXT_PUBLIC_SANDBOX_SCOPE` — team slug for UI display
- `NEXT_PUBLIC_SANDBOX_PROJECT` — project name for UI display

No secrets (tokens, keys, signing secrets) use the `NEXT_PUBLIC_` prefix.

---

### EV-9 [P1/PASS] — Deployment contract checker passes

`scripts/check-verifier-contract.mjs` validates all 11 deployment-contract env vars across `docs/environment-variables.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `.env.example`. Current output: `ok: true`, zero failures.

Tracked vars: `BASE_DOMAIN`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_DOMAIN`, `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID`, `OPENCLAW_PACKAGE_SPEC`, `SESSION_SECRET`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL`, `VERCEL_APP_CLIENT_SECRET`, `VERCEL_AUTOMATION_BYPASS_SECRET`.

Vercel system env vars (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_URL`) are correctly excluded from the doc surface check.

---

### EV-10 [P1/PASS] — Default values are safe

| Variable | Default | Safety |
|---|---|---|
| `ADMIN_SECRET` | Auto-generated 32 random bytes, stored in store | Safe — unique per instance |
| `SESSION_SECRET` | Throws in production without Upstash token; static placeholder in dev only | Safe — blocks production misconfiguration |
| `OPENCLAW_PACKAGE_SPEC` | `openclaw@2026.3.28` (pinned) | Safe — deterministic |
| `OPENCLAW_INSTANCE_ID` | `VERCEL_PROJECT_ID` on Vercel, `openclaw-single` locally | Safe — auto-isolates projects |
| `OPENCLAW_SANDBOX_VCPUS` | 1 | Safe — minimum cost |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | 1800000 (30 min) | Safe — reasonable timeout |
| `CRON_SECRET` | Falls back to `ADMIN_SECRET` | Safe — preflight now correctly reflects effective cron auth via `cronSecretSource` field |

---

### EV-11 [P2/WARN] — Verifier contract does not track ADMIN_SECRET or AI_GATEWAY_API_KEY

The verifier contract checker (`scripts/check-verifier-contract.mjs`) only tracks env vars that appear in `deployment-contract.ts` `env: [...]` arrays. Since `ADMIN_SECRET` and `AI_GATEWAY_API_KEY` are not in any deployment contract requirement's `env` array, they are invisible to the checker.

- `ADMIN_SECRET`: used by `getCronSecret()` as a fallback but not directly in any contract requirement `env` list
- `AI_GATEWAY_API_KEY`: consumed by `getAiGatewayAuthMode()` internally but the `ai-gateway` requirement has `env: []`

**Impact:** If `ADMIN_SECRET` or `AI_GATEWAY_API_KEY` documentation drifts in any of the four checked files, the verifier will not catch it.

---

### EV-12 [P2/FIXED] — OPENCLAW_PACKAGE_SPEC fallback masks the "unset on Vercel" state

- **Evidence**: `.env.example:32-36`, `CLAUDE.md:152`, `CLAUDE.md:550`, `src/server/env.ts:300-311`, `src/server/deployment-contract.ts:250-259`
- **Detail**: The docs say Vercel should warn when `OPENCLAW_PACKAGE_SPEC` is unset or unpinned. Runtime does fall back to a pinned known-good version (`openclaw@2026.3.28`) when unset, but the deployment contract previously checked the resolved fallback string and returned `pass` because that fallback is pinned. That hid the documented "unset" warning state from preflight and launch-verify.
- **Severity**: Medium
- **Status**: Fixed — `getOpenclawPackageSpecConfig()` now preserves source (`explicit` vs `fallback`), and the deployment contract warns on `source === "fallback"` for Vercel deployments.

---

## Unused Env Vars Check

No env vars in `.env.example` are unused in code. Every documented variable has at least one `process.env` reference in source.

## Recommended Fixes (ranked by severity)

### P2 — Should fix before launch

1. **EV-1** *(Implemented)*: Documentation updated across CLAUDE.md, CONTRIBUTING.md, docs/environment-variables.md, and .env.example to reflect the pinned default (`openclaw@2026.3.28`).

2. **EV-2**: Add `ADMIN_SECRET=` to `.env.example` as the first entry. Add `ADMIN_SECRET` to the CLAUDE.md env var table with context: "Required (admin-secret mode). Password for the admin UI. Auto-generated locally if unset."

3. **EV-11**: Add `ADMIN_SECRET` and `AI_GATEWAY_API_KEY` to the deployment contract's env arrays (or add a separate surface check for non-contract operator vars in the verifier script).

4. **EV-12 — Make package-spec resolution source-aware**: Add `getOpenclawPackageSpecConfig()` and update the deployment contract to warn on `source === "fallback"` for Vercel deployments. *(Implemented — `src/server/env.ts:307-311`, `src/server/deployment-contract.ts:247-273`)*

### P3 — Nice to have, not blocking

4. **EV-3**: Add `AI_GATEWAY_API_KEY` and `VERCEL_AUTH_MODE` to the CLAUDE.md env var table.

5. **EV-4**: Document `OPENCLAW_OWNER_ALLOW_FROM` in `docs/environment-variables.md` and `.env.example`.

6. **EV-5**: Add a "Debug and experimental" section to `CONTRIBUTING.md` documenting `ENABLE_DEBUG_ROUTES`, `DEBUG_SANDBOX_SNAPSHOT_ID`, and `OPENCLAW_HOT_SPARE_ENABLED`.

7. **EV-6**: Add `NEXT_PUBLIC_SANDBOX_SCOPE` and `NEXT_PUBLIC_SANDBOX_PROJECT` to `docs/environment-variables.md`.

8. **EV-7**: Add `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the CLAUDE.md env var table.

## Release Recommendation

**Conditional GO.** One documentation accuracy issue (EV-1) should be fixed before launch because it misleads operators about which OpenClaw version will be installed. The `ADMIN_SECRET` omission from `.env.example` (EV-2) is mitigated by the deploy button prompting for it, but remains a gap for operators who clone and configure manually.

No security issues found. No runtime risks. All default values are safe. The deployment contract checker is healthy for its tracked scope.
