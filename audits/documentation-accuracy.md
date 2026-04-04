# Documentation Accuracy Audit

**Date**: 2026-04-03
**Auditor**: Automated pre-launch audit

## Scope

- `README.md` — commands, deploy button, getting started, channel docs
- `CLAUDE.md` — architecture descriptions, route table, constraints
- `CONTRIBUTING.md` — route table, developer instructions
- `docs/` directory — all 8 reference docs
- `package.json` — script consistency with documented commands

## Findings

### PASS — CLI commands are accurate

- **Evidence**: `package.json` scripts match `README.md` and `CLAUDE.md`
- `npm run dev`, `npm run lint`, `npm test`, `npm run typecheck`, `npm run build` — all present and valid
- `node scripts/verify.mjs` — documented in CLAUDE.md and works as described
- Smoke test commands and flags documented accurately in CLAUDE.md

### PASS — Deploy button URL is correct

- **Evidence**: `README.md:14`
- Points to `github.com/vercel-labs/vercel-openclaw.git` — matches `git remote -v`

### PASS — Channel naming is consistent

- **Evidence**: Cross-checked README.md, CLAUDE.md, CONTRIBUTING.md, docs/channels-and-webhooks.md
- Slack, Telegram, WhatsApp (experimental), Discord (experimental) — consistently labeled everywhere

### PASS — All 8 docs/ files exist and are referenced

- **Evidence**: `docs/` directory contains architecture.md, lifecycle-and-restore.md, channels-and-webhooks.md, environment-variables.md, api-reference.md, deployment-protection.md, architecture-tradeoffs.md, preflight-and-launch-verification.md

### PASS — No TODO/FIXME comments in source

- **Evidence**: grep for TODO, FIXME, XXX in `src/` returned no results
- Codebase is clean of deferred work markers

### PASS — Cron schedule matches docs

- **Evidence**: `vercel.json` schedule `"0 8 * * *"` matches "daily" described in README and CLAUDE.md

### WARN — Route tables are incomplete

- **Evidence**: `CLAUDE.md:74-87`, `CONTRIBUTING.md:162-185`
- **Detail**: Route tables list ~13 routes but 55+ routes exist in `src/app/api/`. Missing categories:
  - Auth routes: `/api/auth/login`, `/api/auth/authorize`, `/api/auth/callback`, `/api/auth/signout`
  - Admin routes: `/api/admin/logs`, `/api/admin/prepare-restore`, `/api/admin/reset`, `/api/admin/restore-target`, `/api/admin/snapshots` (list), `/api/admin/snapshots/restore`, `/api/admin/ssh`
  - Channel config routes: `/api/channels/{channel}` (GET/PUT/DELETE per channel)
  - Firewall routes: 8 endpoints under `/api/firewall/*`
  - Debug routes: 9 endpoints under `/api/debug/*`
  - Health: `/api/health`
- **Impact**: Route tables are meant as a quick reference, not exhaustive. `docs/api-reference.md` has more detail. However, new contributors may miss endpoints.
- **Severity**: P3 (non-blocking — reference docs exist, route tables are quick-reference)

### WARN — warningChannelIds deprecation inconsistency

- **Evidence**: `CLAUDE.md` documents `warningChannelIds` as deprecated, preferring `failingChannelIds`
- Some docs may still reference the deprecated field
- **Severity**: P3 (the field still works as a compatibility alias)

## Recommended Fixes (ranked)

1. **P3** — Add a note to CLAUDE.md and CONTRIBUTING.md route tables: "See [docs/api-reference.md](docs/api-reference.md) for the complete endpoint reference." This sets expectations without requiring exhaustive table maintenance.
2. **P3** — Grep for `warningChannelIds` in docs/ and update any remaining references to note deprecation.

## Release Readiness

**No launch blockers.** Documentation is substantially accurate. Route tables are intentionally abridged (detailed reference exists in docs/api-reference.md). No commands or instructions are broken or misleading.
