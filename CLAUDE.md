# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`vercel-openclaw` is a single-instance Next.js 16 app that manages exactly one persistent Vercel Sandbox running OpenClaw: auth, on-demand create/resume, proxy at `/gateway`, HTML injection for WebSocket rewrite and gateway-token handoff, firewall learning, and channel webhooks (Slack, Telegram, Discord, WhatsApp).

For operator docs, see `README.md`, `CONTRIBUTING.md`, and `docs/` (`architecture.md`, `channels-and-webhooks.md`, `lifecycle-and-restore.md`, `preflight-and-launch-verification.md`, `deployment-protection.md`, `environment-variables.md`, `api-reference.md`).

## Commands

Package manager is `pnpm`. Tests use `node:test`.

```bash
pnpm install
pnpm dev
node scripts/verify.mjs             # canonical CI entrypoint; runs lint/test/typecheck/build
node scripts/verify.mjs --steps=test,typecheck
pnpm check:verify-contract          # guards documented env vars across README/CLAUDE.md/CONTRIBUTING.md/.env.example
pnpm smoke:remote --base-url https://my-app.vercel.app [--destructive] [--auth-cookie "session=..."]
```

Use `node scripts/verify.mjs` for all automation and CI — never bare `npm`/`tsx`. For docs-only changes that touch operator env names or instructions, also run `pnpm check:verify-contract`.

## Local dev against prod env

To tweak the admin UI locally while reading real production data:

1. `vercel link && vercel env pull .env.local --environment=production`
2. Edit `.env.local`:
   - set `VERCEL_ENV=development` so `isVercelDeployment()` flips and Redis connects (`src/server/store/store.ts:57`)
   - set `LOCAL_READ_ONLY=1` so every admin mutation returns `403 { error: "LOCAL_READ_ONLY" }` (`src/server/auth/route-auth.ts`)
   - unset `VERCEL_AUTH_MODE` so admin-secret mode works locally
3. `pnpm dev`, then `POST /api/auth/login` with `ADMIN_SECRET` for the session cookie

`getSandboxController()` returns the real v2 SDK whenever `NODE_ENV !== "test"` (`src/server/sandbox/controller.ts:201-211`). Without `LOCAL_READ_ONLY`, `POST /api/admin/stop` from localhost stops the prod sandbox.

## Architecture map

| Subsystem | Entry points |
| --------- | ------------ |
| Store (metadata + side keys) | `src/server/store/{store,redis-store,memory-store,keyspace}.ts`, `src/shared/types.ts` |
| Sandbox lifecycle | `src/server/sandbox/{lifecycle,controller}.ts` |
| OpenClaw bootstrap + restore | `src/server/openclaw/{config,bootstrap}.ts`, `src/server/openclaw/restore-assets.ts` |
| Proxy + HTML injection | `src/app/gateway/[[...path]]/route.ts`, `src/server/proxy/{proxy-route-utils,htmlInjection,waitingPage}.ts` |
| Firewall | `src/server/firewall/{domains,policy,state}.ts` |
| Channels | `src/server/channels/{driver,state,webhook-urls,connectability}.ts`, `src/server/channels/{slack,telegram,whatsapp,discord}/` |
| Auth | `src/server/auth/{admin-auth,admin-secret,session,vercel-auth,route-auth}.ts` |
| Public URL resolution | `src/server/public-url.ts` |
| Preflight / launch verification | `src/server/deploy-preflight.ts`, `src/app/api/admin/{preflight,launch-verify}/route.ts`, `src/app/api/queues/launch-verify/route.ts` |
| Watchdog (cron) | `src/app/api/cron/watchdog/route.ts`, `src/app/api/admin/watchdog/route.ts`, `src/server/watchdog/` |
| Admin UI | `src/components/designs/command-shell.tsx`, `src/components/admin-{action,request}-core.ts` |
| Logs (ring buffer) | `src/server/log.ts` |

The full route inventory is under `src/app/api/` — use that directory as the source of truth, not a duplicated list.

## Critical invariants

These are the things Claude will otherwise get wrong:

- **No `runtime` export on route handlers.** `cacheComponents: true` in `next.config.ts` breaks the Next 16 build if any route declares `export const runtime = "nodejs"`.
- **Sandbox exposes ports 3000 (gateway) and 8787 (Telegram native handler).** Both must be in `SANDBOX_PORTS`. Changing that requires updating bootstrap, lifecycle, proxy, and docs together.
- **All Redis keys go through `src/server/store/keyspace.ts`** — never hardcode the `openclaw-single` prefix. Metadata shape changes must be reflected in `ensureMetaShape`.
- **Redis only connects on deployed Vercel runtimes** (`isVercelDeployment()`). Local dev and CI always use the memory store even if `REDIS_URL`/`KV_URL` are set.
- **`buildPublicUrl()` vs `buildPublicDisplayUrl()`** — the first appends `x-vercel-protection-bypass` (use for outbound delivery / registration URLs); the second strips it (use for admin JSON, UI, diagnostics, docs examples). Never show the bypass secret in UI or logs.
- **AI Gateway token never enters the sandbox.** It's injected via network policy `transform` rules (`buildAiGatewayTransformRules` in `src/server/firewall/policy.ts`). `OPENAI_BASE_URL` is set inside the sandbox; auth happens at the firewall.
- **Firewall policy shape changes when an AI Gateway token is present** — `toNetworkPolicy()` always returns the object form, with `ai-gateway.vercel.sh` always in the allow list (including enforcing mode). Token refresh calls `sandbox.update({ networkPolicy })` — no file writes or gateway restarts.
- **Telegram `webhookSecret` must flow through every config path**: `buildGatewayConfig()`, `buildDynamicResumeFiles()`, `syncRestoreAssetsIfNeeded()`, and `computeGatewayConfigHash()`. Missing it causes OpenClaw validation failure ("webhookUrl requires webhookSecret").
- **Channel connect guard**: `buildChannelConnectability()` and `buildChannelConnectabilityReport()` are **async**. Every channel `PUT` handler must await them and return the shared `buildChannelConnectBlockedResponse` (HTTP 409) when `canConnect` is false. Blockers: no canonical HTTPS webhook URL; AI Gateway auth is `unavailable` on Vercel; missing Redis on Vercel.
- **Auth must happen before proxying any HTML that contains the injected gateway token.** Keep the WebSocket rewrite, the heartbeat `POST /api/status` behavior, and the waiting-page flow in the lifecycle — the proxy depends on them.
- **Cron wake**: `stopSandbox()` and `touchRunningSandbox()` persist the earliest `nextRunAtMs` (`openclaw-single:cron-next-wake-ms`) and full `jobs.json` (`openclaw-single:cron-jobs-json`) to the store. On resume, if the sandbox lost jobs but the store has them, they are written back and the gateway is restarted. The watchdog only wakes — it never runs chat completions. For cron to work, `tools.profile` must be `"full"` and `OPENCLAW_GATEWAY_PORT` must match `--port`.
- **`logDebug` vs `logInfo`**: the `/api/admin/logs` ring buffer only retains info-level entries. Use `logDebug` on any code that runs on every request (status polling, connectability, URL resolution) so operational logs don't get evicted.
- **Test-only controller override**: `_setSandboxControllerForTesting()` is a no-op unless `NODE_ENV=test`. In production, `getSandboxController()` always returns the real `@vercel/sandbox` v2 SDK.
- **`_setAiGatewayTokenOverrideForTesting()`** is the supported way to stub OIDC in tests — do not mock `@vercel/oidc` directly.
- **Updating env vars**: changes to `.env.example`, `README.md`, `CONTRIBUTING.md`, and `CLAUDE.md` must stay in sync — enforced by `scripts/check-verifier-contract.mjs` (`pnpm check:verify-contract`).

## Auth modes

- `admin-secret` (default) — accepts `Authorization: Bearer <admin-secret>` **or** the encrypted `openclaw_admin` session cookie. CSRF is enforced on cookie-based mutations, not bearer. `ADMIN_SECRET` auto-generates locally if unset; `/api/setup` is sealed on Vercel (returns 410).
- `sign-in-with-vercel` — encrypted cookie sessions, JWKS-verified ID token, refresh before expiry; refresh failure clears the session.
- Deployment Protection: auto-detected via a self-probe of `/api/health`. When protection is active but `VERCEL_AUTOMATION_BYPASS_SECRET` is missing, channel connects hard-block.

## Env vars policy (Vercel-specific)

Full list is in `.env.example`. Non-obvious policies:

- **Store requirement**: missing Redis is a hard fail on Vercel but a warning in local/non-Vercel. Applies to both preflight and channel connectability.
- **`CRON_SECRET`**: when unset on Vercel, the runtime falls back to `ADMIN_SECRET` — that's a warning, not a failure. Missing both is a hard fail.
- **`OPENCLAW_PACKAGE_SPEC`**: when unset on Vercel, the runtime falls back to a pinned known-good version (currently `openclaw@2026.4.12`). The deployment contract **warns** — it does not fail.
- **`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_DOMAIN`, `BASE_DOMAIN`**: inputs to `getPublicOrigin()` alongside forwarded headers and Vercel system env vars. Admin-visible URLs must use `buildPublicDisplayUrl()`.
- **`NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` + `VERCEL_APP_CLIENT_SECRET`**: required for `sign-in-with-vercel` OAuth. Missing these is a `auth-config` fail in preflight when that mode is selected.
- **`OPENCLAW_INSTANCE_ID`**: namespaces Redis keys. On Vercel it auto-uses `VERCEL_PROJECT_ID` when unset; locally falls back to `openclaw-single`. Changing it points at a new namespace — it does not migrate existing state.
- **`OPENCLAW_SANDBOX_SLEEP_AFTER_MS`**: existing running sandboxes can only be lengthened in place; shortening takes effect on next create/restore.
- **`SESSION_SECRET`**: auto-generated in admin-secret mode; must be explicitly set for `sign-in-with-vercel` on Vercel.

## Launch verification

`POST /api/admin/launch-verify` is the public readiness entrypoint. It returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`, and supports NDJSON streaming when the client sends `Accept: application/x-ndjson` — the terminal `result` event carries the same extended payload including `channelReadiness`. `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment. `channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` path. `failingChannelIds` is the canonical machine-readable channel failure list; `warningChannelIds` is deprecated and should not be used in new automation.

## Current sharp edges

- Memory store is not safe for production persistence.
- Firewall learning is based on shell-command observation, not full traffic inspection.
- Channel webhook durability depends on the store backend — use Redis when channels matter.

## Design context

See `.impeccable.md` for the full design reference. Principles in short: signal over decoration (no ornamental color or shadows), density with clarity, quiet confidence (≤150ms transitions), Vercel-native feel (Geist, monochrome, 1px borders, pill badges), operator-first. Dark-only, WCAG AA. References: Vercel Dashboard, Linear. Admin UI mounts at `/` and is a control surface, not a dashboard framework.
# Before starting work

- Run `lat search` to find sections relevant to your task. Read them to understand the design intent before writing code.
- Run `lat expand` on user prompts to expand any `[[refs]]` — this resolves section names to file locations and provides context.

# Post-task checklist (REQUIRED — do not skip)

After EVERY task, before responding to the user:

- [ ] Update `lat.md/` if you added or changed any functionality, architecture, tests, or behavior
- [ ] Run `lat check` — all wiki links and code refs must pass
- [ ] Do not skip these steps. Do not consider your task done until both are complete.

---

# What is lat.md?

This project uses [lat.md](https://www.npmjs.com/package/lat.md) to maintain a structured knowledge graph of its architecture, design decisions, and test specs in the `lat.md/` directory. It is a set of cross-linked markdown files that describe **what** this project does and **why** — the domain concepts, key design decisions, business logic, and test specifications. Use it to ground your work in the actual architecture rather than guessing.

# Commands

```bash
lat locate "Section Name"      # find a section by name (exact, fuzzy)
lat refs "file#Section"        # find what references a section
lat search "natural language"  # semantic search across all sections
lat expand "user prompt text"  # expand [[refs]] to resolved locations
lat check                      # validate all links and code refs
```

Run `lat --help` when in doubt about available commands or options.

If `lat search` fails because no API key is configured, explain to the user that semantic search requires a key provided via `LAT_LLM_KEY` (direct value), `LAT_LLM_KEY_FILE` (path to key file), or `LAT_LLM_KEY_HELPER` (command that prints the key). Supported key prefixes: `sk-...` (OpenAI) or `vck_...` (Vercel). If the user doesn't want to set it up, use `lat locate` for direct lookups instead.

# Syntax primer

- **Section ids**: `lat.md/path/to/file#Heading#SubHeading` — full form uses project-root-relative path (e.g. `lat.md/tests/search#RAG Replay Tests`). Short form uses bare file name when unique (e.g. `search#RAG Replay Tests`, `cli#search#Indexing`).
- **Wiki links**: `[[target]]` or `[[target|alias]]` — cross-references between sections. Can also reference source code: `[[src/foo.ts#myFunction]]`.
- **Source code links**: Wiki links in `lat.md/` files can reference functions, classes, constants, and methods in TypeScript/JavaScript/Python/Rust/Go/C files. Use the full path: `[[src/config.ts#getConfigDir]]`, `[[src/server.ts#App#listen]]` (class method), `[[lib/utils.py#parse_args]]`, `[[src/lib.rs#Greeter#greet]]` (Rust impl method), `[[src/app.go#Greeter#Greet]]` (Go method), `[[src/app.h#Greeter]]` (C struct). `lat check` validates these exist.
- **Code refs**: `// @lat: [[section-id]]` (JS/TS/Rust/Go/C) or `# @lat: [[section-id]]` (Python) — ties source code to concepts

# Test specs

Key tests can be described as sections in `lat.md/` files (e.g. `tests.md`). Add frontmatter to require that every leaf section is referenced by a `// @lat:` or `# @lat:` comment in test code:

```markdown
---
lat:
  require-code-mention: true
---
# Tests

Authentication and authorization test specifications.

## User login

Verify credential validation and error handling for the login endpoint.

### Rejects expired tokens
Tokens past their expiry timestamp are rejected with 401, even if otherwise valid.

### Handles missing password
Login request without a password field returns 400 with a descriptive error.
```

Every section MUST have a description — at least one sentence explaining what the test verifies and why. Empty sections with just a heading are not acceptable. (This is a specific case of the general leading paragraph rule below.)

Each test in code should reference its spec with exactly one comment placed next to the relevant test — not at the top of the file:

```python
# @lat: [[tests#User login#Rejects expired tokens]]
def test_rejects_expired_tokens():
    ...

# @lat: [[tests#User login#Handles missing password]]
def test_handles_missing_password():
    ...
```

Do not duplicate refs. One `@lat:` comment per spec section, placed at the test that covers it. `lat check` will flag any spec section not covered by a code reference, and any code reference pointing to a nonexistent section.

# Section structure

Every section in `lat.md/` **must** have a leading paragraph — at least one sentence immediately after the heading, before any child headings or other block content. The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). This paragraph serves as the section's overview and is used in search results, command output, and RAG context — keeping it concise guarantees the section's essence is always captured.

```markdown
# Good Section

Brief overview of what this section documents and why it matters.

More detail can go in subsequent paragraphs, code blocks, or lists.

## Child heading

Details about this child topic.
```

```markdown
# Bad Section

## Child heading

Details about this child topic.
```

The second example is invalid because `Bad Section` has no leading paragraph. `lat check` validates this rule and reports errors for missing or overly long leading paragraphs.
