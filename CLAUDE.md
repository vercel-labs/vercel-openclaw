# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`vercel-openclaw` is a single-instance Next.js 16 app that manages exactly one persistent Vercel Sandbox running OpenClaw: auth, on-demand create/resume, proxy at `/gateway`, HTML injection for WebSocket rewrite and gateway-token handoff, firewall learning, and channel webhooks (Slack, Telegram, Discord, WhatsApp).

For operator docs, start with `docs/getting-started/README.md`. It is the main handoff for the three-repo system (`vclaw`, `vercel-openclaw`, and the OpenClaw fork), `vclaw create`, operational paths, release, and reliability contracts. Then use `README.md`, `CONTRIBUTING.md`, and the deep docs under `docs/` (`architecture.md`, `channels-and-webhooks.md`, `lifecycle-and-restore.md`, `preflight-and-launch-verification.md`, `deployment-protection.md`, `environment-variables.md`, `api-reference.md`).

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

## Main guide / getting started

Read `docs/getting-started/README.md` before changing setup, provisioning, release, bundle compatibility, or cross-repo behavior. The guide was integrated from `~/dev/vclaw-handoff` and is now the canonical in-repo onboarding path.

Guide pages:

- `docs/getting-started/system-map.md` — three-repo architecture and ownership boundaries.
- `docs/getting-started/operational-paths.md` — create/deploy, sandbox boot/proxy, channel delivery, and verification boundaries.
- `docs/getting-started/vclaw-create.md` — supported install flow, flags, non-interactive runs, and failure boundaries.
- `docs/getting-started/release-and-reliability.md` — OpenClaw bundle assets, dashboard verification, CLI publish, and risk areas.

Keep `README.md`, `docs/README.md`, and this file in sync when the guide moves or its scope changes. `AGENTS.md` is a symlink to this file, so updates here are also the agent-facing instructions.

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

## Debugging channel delivery

When a channel (Slack/Telegram/Discord/WhatsApp) is "stuck" — message sent, bot doesn't reply — start here. **Always read the structured surfaces before guessing**: vague error strings have repeatedly masked different bugs.

### Discipline first, code second

This system has layered failures (OAuth, sandbox lifecycle, gateway routes, plugin loading, cached URLs, fast path vs workflow). When debugging it, follow this discipline — past sessions burned hours when we let momentum override evidence.

### Start with parallel evidence fan-out

For live channel incidents, the parent agent must start with parallel evidence collection. Before any patch proposal, create one artifact root and spawn these lanes in parallel:

```bash
CHANNEL=<slack|telegram|discord|whatsapp>
RUN_TS="$(date -u +%Y%m%dT%H%M%SZ)"
ART=".agent-runs/channel-debug/$RUN_TS/$CHANNEL"
mkdir -p "$ART"/{admin,vercel,sandbox,workflow,channel}
```

Before running `vercel`, `npx sandbox`, or `npx workflow`, prove the command is targeting the intended Vercel project/team/deployment. Inspect `.vercel/project.json`; if it points at a different release, use explicit project/team/deployment targeting and record the mismatch. This repo may still be linked to release 45 (`vercel-openclaw-45`, `prj_ag6Uzj9b4deNK98jVS5SO0H2Shmx`), while release 46 uses `vercel-openclaw-46`, `prj_JSzrXyJiMzT6F7BUA76Naa7nkjRa`, team `vercel-internal-playground`. If a tool says it inferred the project from `.vercel`, treat the output as suspect until it matches the incident target.

If a release-specific env file is supplied, such as `.env.45` for release 45, source it only in the shell running live investigation commands:

```bash
set -a
. ./.env.45
set +a
```

Use release env files only for live investigation context: deployment URL, Vercel token/project/team/deployment context, `ADMIN_SECRET`, Deployment Protection bypass, and platform credentials required to inspect that run. Never paste, print, or save raw values. Evidence may record `envFileUsed: ".env.45"` and the names of variables used, not their values.

#### Protected release probes and Slack setup CSRF

Do not blindly source `vercel env pull` output into your shell. The Vercel CLI writes encrypted env values as empty placeholders, so `.env.<release>.local` may contain `ADMIN_SECRET=` and `VERCEL_AUTOMATION_BYPASS_SECRET=` even when `vercel env ls` shows both as `Encrypted`. Parse only the specific keys you need, or use an isolated subshell and immediately restore `PATH`.

If `vercel env pull` cannot provide the automation bypass, recover it through the Vercel project protection API in memory and never print it:

```js
import fs from "node:fs";
import { readVercelToken, findAutomationBypassSecret } from "../vclaw/src/vercel-api.mjs";

const token = readVercelToken();
const { projectId, orgId } = JSON.parse(fs.readFileSync(".vercel/project.json", "utf8"));
const found = await findAutomationBypassSecret(token, projectId, orgId);
// Use found.secret only as x-vercel-protection-bypass in live probes.
```

When probing protected deployments, try both the stable project alias and the deployment hash URL. Save sanitized metadata for each response: requested base, path, HTTP status, final URL with bypass redacted, and content type. Interpret failures precisely: `401 text/html` is Vercel Deployment Protection; `401 application/json` is app auth; `403` with `CSRF_ORIGIN_MISMATCH` or UI text `Cross-origin request blocked.` is app CSRF/origin handling.

For Slack app setup, `/api/admin/logs` event `auth.csrf_blocked` on `POST /api/channels/slack/app` means the Slack app creation mutation was blocked before sandbox config or channel forwarding began. Check whether the admin page origin, request URL origin, and canonical public origin differ across Vercel aliases before touching sandbox code. The stable alias should remain canonical for Slack OAuth redirect and webhook URLs, but the deployment hash URL must still work for same-origin admin UI mutations.

Parallel lanes:

- **Vercel/app logs + admin surfaces lane** — collect deployment proof, project targeting proof, admin readiness endpoints, and Vercel runtime logs. Save `why-not-ready.json`, `channels-summary.json`, `sandbox-diag.json`, `admin-logs.json`, `channel-runtime.jsonl`, and request-id logs when available.
- **Sandbox runtime lane** — extract the actual Vercel Sandbox ID from `/api/admin/sandbox-diag` or recent `lastForward.sandboxId`. Do not pass `oc-prj*`, `prj_*`, `OPENCLAW_INSTANCE_ID`, or `VERCEL_PROJECT_ID` as the positional sandbox ID to `npx sandbox`. If `npx sandbox` rejects the ID or cannot authenticate, save stdout/stderr and use the app admin SSH/exec fallback for the same read-only probes: process list, ports 3000/8787, sanitized OpenClaw config shape, recent OpenClaw logs, route probes, and known-regression signatures such as openclaw-42.
- **Workflow state lane** — inspect Vercel Workflow runs for the incident window with `npx workflow inspect runs --backend vercel`, only after project targeting is verified. Filter for `drainChannelWorkflow`, the channel, request ID, delivery ID, platform event ID, and message time. If `npx workflow` cannot inspect remote Vercel state, save the failure and fall back to Vercel logs plus `/api/admin/logs` events such as `channels.<ch>_workflow_started`, `channels.forward_attempt`, and `channels.forward_outcome`. Do not treat local workflow data as production evidence.
- **Channel specialist lane** — run `channel_slack`, `channel_telegram`, `channel_discord`, or `channel_whatsapp`. The specialist owns route semantics, signatures/raw body, dedup behavior, boot-message behavior, terminal-path audit, and prior-fix comparison.

Merge gate before fixes: all lane handoffs are present, or any missing lane is explicitly marked unavailable with the reason and fallback used; at least one runtime edge is `verified-bad`; lane evidence does not contradict itself, or the contradiction is the next hypothesis; and the hypothesis table compares prior fixes including openclaw-42, stale sandbox URL, workflow retry exhaustion, channel-specific signature/secret issues, and recent accepted-forward override behavior.

**Before touching code, produce four artifacts:**

1. **Runtime path diagram.** The full delivery pipeline for the channel in question:
   ```
   Slack UI message → webhook route → fast path? → workflow fallback?
     → sandbox public URL → gateway → plugin route registered? → native handler
     → bot reply → readiness/summary updated
   ```
   Mark every edge as `unknown / verified-good / verified-bad`. Do not propose a fix until at least one edge is `verified-bad`.

2. **Hypothesis table.** Maintain it for the whole session. No silent pivots.
   ```
   Hypothesis | Evidence for | Evidence against | Fastest falsifier | Status
   ```
   Update `Status` to `ruled-out` when a falsifier comes back negative — keep the row visible. New theories don't replace old ones; they queue.

3. **Definition of done.** Write this before opening any code. Example:
   ```
   1. App connected.        2. Real Slack-UI msg reaches the bot.
   3. Bot replies in DM.    4. summary.lastForward.ok:true classification:accepted.
   5. deliveryReady && routeReady true.   6. why-not-ready has no blocker.
   7. Tests pass.           8. Committed + pushed.   9. CLAUDE.md updated if new failure mode found.
   ```

4. **Deployment-state proof.** Before reasoning about runtime behavior, prove the deployed code matches the source you're reading:
   ```bash
   git rev-parse HEAD                       # local
   git ls-remote origin main                # what main has
   curl $URL/api/admin/sandbox-diag         # what's deployed (or any build-info endpoint)
   ```
   If they don't line up, fix that first. No proof, no debugging.

**Stop-the-line rules.** Stop and reassess if any of these fire:

- The same error string appears after a "fix" — classification is too vague, not necessarily that the fix failed. **If two failure modes produce the same operator-facing message, add classification before fixing.** This is what bit us with `"Slack route did not become ready after config sync restart"` masking three distinct bugs.
- You're about to write "most likely" for the second time in a row — gather direct evidence instead.
- A route has multiple terminal paths and only one is instrumented — enumerate all of them. For any webhook change, the checklist is: fast-path success, fast-path non-2xx, fast-path fetch exception, fast-path skipped, workflow success, workflow exhausted, dedup skip, invalid signature, no credentials. Each terminal path **must** log; each delivery path **must** update `lastForward`; each skip path **must** explain why.
- Words `connected` / `oauth-complete` / `delivery-ready` are being used interchangeably — split them. Distinct states: `oauthComplete`, `credentialsSaved`, `authTestPassed`, `configSyncApplied`, `handlerRegistered`, `lastForwardAccepted`, `deliveryReady`. One vague label hides bugs.
- Browser automation can't see the DOM — **reload the tab and verify exact tab URL/IDs first** before guessing selectors. Cross-check server-side `lastForward` rather than trusting only the UI read. The `slack-ui` skill encodes this; use it.
- A code change is staged without a verification step — write the repro/verify command first.

**On finding "the real bug."** When you think you've found it, ask:
- What evidence rules out the previous hypothesis?
- What runtime signal proves *this* one (not just correlates)?
- Which paths haven't been checked?
- Could this be a *second* bug rather than *the* bug? (Layered failures are common here.)

**Commit shape.** Prefer many small commits over one sprawling one. Each commit:
- names the exact failure it addresses,
- includes a verification step (test or manual),
- shows a before/after signal.

This makes rollback and review sane and forces honest scoping.

### Where to look, in order

### Codex channel specialists

Use the repo-local Codex channel specialists for Slack, Telegram, Discord, and WhatsApp delivery work. The custom agent role files live in `.codex/agents/*.toml`; the reusable playbooks live in `.agents/skills/*/SKILL.md`. Codex loads `.agents/skills` as shared skills, but channel specialist roles must stay in `.codex/agents`.

Start every channel incident with `$channel-debug-core`; it requires deployment proof, the admin readiness surfaces, a runtime path diagram, a hypothesis table, and a handoff before any fix. Use `$channel-forward-parity` before changing a webhook route or `src/server/workflows/channels/drain-channel-workflow.ts`.

For parallel triage, explicitly spawn project agents and keep ownership narrow:

| Channel | Agent | Primary skill | Evidence focus |
| --- | --- | --- | --- |
| Telegram | `channel_telegram` | `telegram-native-8787` | Native port 8787, webhook secret flow, boot cleanup, user-visible replies |
| Slack | `channel_slack` | `slack-delivery` | OAuth vs delivery-ready, raw-body signature forwarding, `/slack/events` fast path |
| Discord | `channel_discord` | `discord-delivery` | Ed25519 verification, interaction deferral, token expiry, workflow forwarding |
| WhatsApp | `channel_whatsapp` | `whatsapp-delivery` | Meta verification, raw-body signatures, link-state projection, boot messages |

| Lane | Agent | Evidence focus |
| --- | --- | --- |
| Vercel/app logs | `channel_vercel_logs` | Project targeting, deployment proof, admin readiness JSON, Vercel runtime logs |
| Sandbox runtime | `channel_sandbox_runtime` | `npx sandbox` or app admin SSH fallback, OpenClaw process/ports/config/logs |
| Workflow state | `channel_workflow_state` | `npx workflow inspect runs --backend vercel`, drain workflow state, fallback log correlation |

Each specialist must return `.agents/skills/channel-debug-core/references/handoff-template.md` before proposing a fix. Specialists may read shared channel core files, but only one implementation owner may edit shared workflow/readiness/summary code in a given task.

Required debugging flow after the parallel fan-out merge gate:

1. Prove the deployed runtime matches the source: `git rev-parse HEAD`, `git ls-remote origin main`, and a live `GET /api/admin/sandbox-diag` or equivalent build/deploy signal.
2. Collect `GET /api/admin/why-not-ready`, `GET /api/channels/summary`, `GET /api/admin/sandbox-diag`, and `GET /api/admin/logs` before editing code.
3. Mark each runtime edge `unknown`, `verified-good`, or `verified-bad`. Do not propose a fix until at least one edge is `verified-bad`.
4. Report `route-ready`, `native-accepted`, and `user-visible-reply` separately. A green `lastForward` is not proof that a human saw a reply.
5. Save raw runtime evidence under `.agent-runs/channel-debug/<timestamp>/` and do not commit it. Redact admin secrets, bypass secrets, bot tokens, webhook secrets, and platform access tokens.

### Codex subsystem specialists

Use the repo-local subsystem specialists when the incident is not primarily channel delivery. The custom role files live in `.codex/agents/*.toml`; the reusable playbooks live in `.agents/skills/*/SKILL.md`.

| Area | Agent | Primary skill | Evidence focus |
| --- | --- | --- | --- |
| Cron/watchdog | `cron_watchdog` | `cron-watchdog-debug` | Vercel Cron auth, watchdog report checks, cron wake key, token refresh, OpenClaw scheduled-job evidence |
| Sandbox lifecycle | `sandbox_lifecycle` | `sandbox-lifecycle-debug` | metadata status vs SDK status, create/resume/stop/snapshot/reset, stale-running reconciliation, locks |
| Gateway/proxy | `gateway_proxy` | `gateway-proxy-debug` | `/gateway`, HTML injection, WebSocket rewrite, waiting page, gateway-token handoff, port URL cache |
| Firewall/AI Gateway | `firewall_ai_gateway` | `firewall-ai-gateway-debug` | network policy, OIDC token refresh, transform rules, firewall learning/enforcement |
| Auth/store | `auth_store` | `auth-store-debug` | admin-secret, Vercel auth, sessions, CSRF, Redis vs memory store, keyspace, metadata shape |
| OpenClaw bootstrap | `openclaw_bootstrap` | `openclaw-bootstrap-debug` | bundle sidecars, config hashes, restore assets, plugin discovery, gateway restart scripts |
| Launch verification | `launch_verify` | `launch-verify-debug` | preflight, queue ping, ensureRunning, chatCompletions, wakeFromSleep, restorePrepared, channelReadiness |
| Admin UI | `admin_ui` | `admin-ui-debug` | command shell, action/request helpers, operator UI state, local read-only workflows |

For cron incidents, start with `$cron-watchdog-debug`. It requires deployment proof, a watchdog path diagram, a hypothesis table, sanitized cron job evidence, and a handoff before any fix. Keep Vercel Cron invocation, watchdog authorization, persisted wake due, sandbox wake, token refresh, OpenClaw scheduler execution, and user-visible delivery as separate states.

1. **`GET /api/admin/why-not-ready`** — aggregator. Returns typed `blockers` per channel with `kind`, `evidence`, `suggestedAction`. Single round-trip to "why is this channel red right now?". Implementation: `src/server/admin/why-not-ready.ts` → `buildWhyNotReady()`.
2. **`GET /api/channels/summary`** — operator-facing readiness. The `slack.lastForward` (and equivalents for other channels) is the live forward outcome from `meta.channelDiagnostics.<ch>.lastForward`: `{ ok, status, classification, attempts, totalMs, sandboxUrl, sandboxId, finalReasonHead, completedAt, ageMs }`. **A green `lastForward.ok:true classification:"accepted"` within 5 minutes overrides a stale `liveConfigSync.outcome:"failed"`** (`src/app/api/channels/summary/route.ts` `buildSlackSummaryEntry`).
3. **`GET /api/admin/sandbox-diag`** — per-port handler probes. Tells you whether port 3000 returns 200 (gateway up), 401 (Slack handler bound, signature-required), 404 (gateway up but handler not registered), or "Not listening" (sandbox port dead).
4. **`GET /api/admin/logs`** — structured ring buffer. Filter by event prefix: `channels.`, `gateway.`, `sandbox.`, `proxy.`. The new instrumentation (commit `37b467f`) means every silent transition now emits a structured event.

### Plugin-loading wedge: zero plugins after configSync restart (openclaw-42)

**Symptom:** Slack OAuth completes, configSync writes `openclaw.json` with `channels.slack`, but `/slack/events` returns 404 forever (70 attempts, 30s, last status 404). `lastForward.classification: "exhausted" finalReasonHead: "Not Found"`. Sandbox-diag: gateway port 3000 returns 200, slack port returns 404 "Handler not registered yet". Inside the sandbox: gateway log shows `http server listening (0 plugins, 1.2s)` and a chain of `[openclaw] <defunct>` zombies.

**Root cause:** `buildGatewayKillShell` (`src/server/openclaw/config.ts:403`) used a grep pattern `[o]penclaw\.gateway|[o]penclaw\.bundle\.mjs gateway` to find the running gateway. The bundle calls `process.title = "openclaw"` early in boot, which overwrites argv[0] in `/proc/PID/cmdline` (and therefore `ps aux`'s COMMAND column) — so `ps aux | grep` finds nothing post-title-init. The kill silently no-ops; the new gateway spawned by `setsid node openclaw.bundle.mjs gateway --port 3000` collides with the still-running old one on port 3000, dies, becomes a zombie. The original gateway (from initial bootstrap, before any channel was configured) keeps running with **zero plugins** and never gets the slack route registered. The same bug is duplicated in the fast-restore script's `pkill -f`/`pgrep -f` block.

**Fix:** kill must match BOTH the pre-title-overwrite argv form (`/[o]penclaw\.bundle\.mjs gateway/`) AND the post-title-overwrite comm form (`$2 == "openclaw"` in `ps -eo pid,comm,args`, plus `pkill -x openclaw` / `pgrep -x openclaw` for the fast-restore path). The `[o]penclaw` regex trick still excludes the awk pipeline from matching itself.

**Diagnostic checklist** when `lastForward.classification === "exhausted"` and `finalReasonHead === "Not Found"`:
1. `sandbox-diag` shows port 3000 = 200 but slack port = 404? → handler missing.
2. SSH `ps aux | grep openclaw` — multiple `[openclaw] <defunct>` zombies? → restart script can't kill the running gateway.
3. SSH `tail /tmp/openclaw/openclaw-*.log` — boot sequence stops at `"starting..."` without ever reaching `"starting HTTP server..."`? → new gateway died on port-conflict.
4. SSH `cat /home/vercel-sandbox/.openclaw/openclaw.json | grep channels` — config has `channels.slack`? → wrapper-side config is correct, this is a runtime kill bug.

If all four match, you're seeing the openclaw-42 wedge. The deployed code already has the fix (commit after this CLAUDE.md update); existing sandboxes need either `POST /api/admin/reset` (regenerates the script and re-bootstraps) or a manual SSH `kill <pid>` of the old gateway followed by `bash /home/vercel-sandbox/.openclaw/.restart-gateway.sh`.

### The three failure modes that used to look identical

Before the observability pass, all three surfaced as `"Slack route did not become ready after config sync restart"`. They are very different:

| Symptom | Real cause | `lastForward.classification` | Fix |
|---|---|---|---|
| Sandbox is up, slack returns 404 from `/slack/events` | Channel handler never registered (configSync failed during install or wake) | `handler-not-ready` or `exhausted` with `finalReasonHead: "Not Found"` | `POST /api/admin/reset` to re-run full provisioning |
| Gateway returns Vercel platform 502 + body `"This sandbox is not listening"` | Cached `meta.portUrls[port]` points at a dead sandbox public URL (sandbox was suspended/snapshotted but cache wasn't invalidated) | `sandbox-not-listening` | Auto-fixed: fast path detects body, calls `markSandboxPortUrlStale`, retries with fresh URL |
| 20 retries × 2s burning through the workflow path | Sandbox itself wedged or restarting | `exhausted` (with `attempts:20`) | `POST /api/admin/reset`; check `gateway.route_probe` logs for the per-attempt status sequence |

### Greppable event timeline

When debugging, search `/api/admin/logs` for the requestId and follow the chain. Key prefixes:

- `channels.<ch>_webhook_accepted` — webhook landed
- `channels.<ch>_fast_path_skipped` — fast path bypassed; **always carries a structured `reason`** (e.g. `sandbox_status_snapshotting`, `listener_not_ready`, `no_sandbox_id`)
- `channels.<ch>_fast_path_ok` / `_failed` / `_fallback_to_workflow` — fast-path outcome
- `channels.<ch>_boot_message_sent` — wrapper sent the user a "waking up..." holding message
- `channels.<ch>_workflow_started` — durable workflow took over (cold-wake path)
- `channels.forward_attempt` — per-attempt log inside `forwardToNativeHandlerWithRetry` (workflow path); fields: `channel, attempt, transport, status, classification, elapsedMs`
- `channels.forward_outcome` — final outcome written by `recordChannelLastForward` (mirrors `lastForward`)
- `gateway.config_built` — `bundledDiscovery, allow, channels, configHash` snapshot when the gateway config JSON is rebuilt
- `gateway.restart_started` / `gateway.restart_completed` — every gateway restart with `reason` ("config-sync", "unspecified", etc.) and `durationMs`
- `gateway.route_probe` — per-attempt route-readiness probe with `status, attempt, elapsedMs`
- `gateway.route_ready_timeout` — replaces the old vague string; carries `channel, lastStatus, attempts, totalMs`
- `sandbox.port_urls.invalidated` — cache cleared (logged with `oldUrls` and `reason`)
- `sandbox.port_urls.refreshed` — `getSandboxDomain` cache miss with new URL
- `sandbox.port_url_dead` — `markSandboxPortUrlStale` was called

### Channel parity rules — every fast path MUST

These invariants hold across slack/telegram/discord/whatsapp webhook routes (`src/app/api/channels/<ch>/webhook/route.ts`). When adding a new channel or touching an existing fast path:

1. Call `recordChannelLastForward(<channel>, {...})` in **every** fast-path branch (success, gateway-error, non-ok, network/timeout) — both the success and failure cases. Otherwise `lastForward` stays null and `/api/channels/summary` can't surface readiness.
2. Use the unified classification rules in failure branches: body matches `/^This sandbox is not listening/` → `sandbox-not-listening`; status ≥ 502 → `proxy-error`; status === 404 → `handler-not-ready`; other non-2xx → `handler-error`; network/timeout → `fetch-exception`.
3. On `sandbox-not-listening`, call `markSandboxPortUrlStale(sandboxId, port, "fast-path-not-listening")` exactly once per request (guard with a local flag). The next forward will get a fresh URL.
4. Log a `channels.<ch>_fast_path_skipped` event with a structured `reason` whenever the gating if-condition evaluates false. Silent bypass = unsolvable bug.
5. Workflow path (`drain-channel-workflow.ts forwardToNativeHandlerWithRetry`) already calls `recordChannelLastForward` and emits `channels.forward_attempt` for every channel uniformly — don't duplicate it on top of the workflow.

### Slack OAuth "did not finish in time" is misleading

`vclaw create --slack` polls for `deliveryReady:true`. OAuth itself completes — credentials are saved and `auth.test` passes — but if the configSync that runs during install hits "Slack handler not registered" (404), `liveConfigFresh` stays false and the polling times out. The fix is `POST /api/admin/reset` to re-run full provisioning; the recently-accepted-forward override then flips both `deliveryReady` and `routeReady` true on the next real Slack message.

### Wake-from-sleep timeline (canonical)

When a Slack message arrives while sandbox is `snapshotting`/`suspended`:

```
channels.slack_webhook_accepted
channels.slack_fast_path_skipped reason="sandbox_status_<state>"
channels.slack_boot_message_sent          ← user sees "Waking up..."
channels.slack_workflow_started           ← workflow path takes over
sandbox.status_transition: <state> → setup → running
gateway.config_built / gateway.restart_*
channels.forward_attempt attempt=1 status=404 classification=handler-not-ready
channels.forward_attempt attempt=2 status=200 classification=accepted
channels.forward_outcome ok=true classification=accepted attempts=2
```

`attempts=2` is normal on cold wake — the first probe lands before the gateway re-mounted the route. `attempts > 2` indicates a real problem.

### Quick triage script

```bash
BYPASS=<your-VERCEL_AUTOMATION_BYPASS_SECRET>
ADMIN=<your-ADMIN_SECRET>
URL=https://<your-deployment>.vercel.app
H="-H Authorization:Bearer\ $ADMIN -H x-vercel-protection-bypass:$BYPASS"

curl -s $H "$URL/api/admin/why-not-ready" | jq .channels         # blockers per channel
curl -s $H "$URL/api/channels/summary"     | jq '.slack.lastForward, .slack.readiness'
curl -s $H "$URL/api/admin/sandbox-diag"   | jq '.sandboxStatus, .ports'
curl -s $H "$URL/api/admin/logs"           | jq '.logs[] | select(.message | startswith("channels.") or startswith("gateway.") or startswith("sandbox."))' | head -100
```

If `lastForward.classification === "sandbox-not-listening"` and the URL doesn't auto-refresh, the fix has regressed — check `markSandboxPortUrlStale` is still wired into the relevant fast path. If `sandbox-diag` shows port 3000 with `httpStatus:404 message:"Handler not registered yet"` and stays stuck, the gateway's bundle never bound the channel route — `POST /api/admin/reset`.

## Auth modes

- `admin-secret` (default) — accepts `Authorization: Bearer <admin-secret>` **or** the encrypted `openclaw_admin` session cookie. CSRF is enforced on cookie-based mutations, not bearer. `ADMIN_SECRET` auto-generates locally if unset; `/api/setup` is sealed on Vercel (returns 410).
- `sign-in-with-vercel` — encrypted cookie sessions, JWKS-verified ID token, refresh before expiry; refresh failure clears the session.
- Deployment Protection: auto-detected via a self-probe of `/api/health`. When protection is active but `VERCEL_AUTOMATION_BYPASS_SECRET` is missing, channel connects hard-block.

## Env vars policy (Vercel-specific)

Full list is in `.env.example`. Non-obvious policies:

- **Store requirement**: missing Redis is a hard fail on Vercel but a warning in local/non-Vercel. Applies to both preflight and channel connectability.
- **`CRON_SECRET`**: when unset on Vercel, the runtime falls back to `ADMIN_SECRET` — that's a warning, not a failure. Missing both is a hard fail.
- **`OPENCLAW_PACKAGE_SPEC`**: when unset on Vercel, the runtime falls back to a pinned known-good version (currently `openclaw@2026.4.12`). The deployment contract **warns** — it does not fail.
- **`OPENCLAW_BUNDLE_URL` / `OPENCLAW_BUNDLE_UI_URL`**: set by `vclaw` when it pins a published OpenClaw bundle. Keep these aligned with `OPENCLAW_PACKAGE_SPEC`; a package spec alone does not prove the sidecar asset set is present.
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
