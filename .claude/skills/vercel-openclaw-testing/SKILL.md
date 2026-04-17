---
name: vercel-openclaw-testing
description: Testing, debugging, and issue-finding guide for the vercel-openclaw project (single Next.js 16 app at vercel-labs/vercel-openclaw). Covers production debugging playbooks, known failure patterns, remote diagnostic workflows, debug routes, admin endpoints, benchmarking scripts, the scenario harness, fake sandbox controller, fake fetch, route callers, auth fixtures, webhook builders, assertion helpers, full smoke test patterns, mock patterns for each subsystem, and the complete verification protocol. Use when writing tests, debugging failures, investigating production issues, profiling performance, or verifying work in the vercel-openclaw repo.
metadata:
  filePattern:
    - "**/vercel-openclaw/**/*.test.ts"
    - "**/vercel-openclaw/**/*.test.tsx"
    - "**/vercel-openclaw/src/server/**"
    - "**/vercel-openclaw/src/test-utils/**"
    - "**/vercel-openclaw/scripts/**"
  bashPattern:
    - "pnpm test"
    - "pnpm test:watch"
    - "node scripts/verify.mjs"
    - "pnpm smoke:remote"
    - "node scripts/check-deploy-readiness.mjs"
    - "node scripts/benchmark-restore.mjs"
    - "node scripts/bench-sandbox-direct.mjs"
    - "node scripts/reset-meta.mjs"
---

# vercel-openclaw Testing

Full testing playbook for `vercel-openclaw` — a single Next.js 16 App Router project deployed to Vercel.

## Agent Environment File (`.env.agent`)

The file `.env.agent` in the repo root contains non-secret configuration for remote testing. It is gitignored (`.env*` pattern) and intentionally separate from `.env.local` (which has real production secrets like Redis connection strings).

**Read this file before running any remote commands.** It provides:

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_BASE_URL` | The deployed app URL (e.g. `https://vercel-openclaw.labs.vercel.dev`) |
| `OPENCLAW_DEPLOYMENT_ID` | The exact deployment ID currently under investigation |
| `OPENCLAW_PROJECT_ID` | The Vercel project ID for `vercel-labs/vercel-openclaw` |
| `OPENCLAW_SCOPE` | The Vercel scope/team slug (`vercel-labs`) |
| `ADMIN_SECRET` | The admin secret for bearer token auth |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Vercel deployment protection bypass secret |

Usage: source the file or read the values before running remote scripts:

```bash
# Source it
source .env.agent

# Then use in commands
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET"
pnpm smoke:remote --base-url "$OPENCLAW_BASE_URL" --destructive
```

**Important:** `.env.agent` should only contain values safe for AI agents to read. Never put Redis URLs, OIDC secrets, session secrets, or channel signing keys here — those belong in `.env.local`.

## Running Instance Investigation

Use this playbook when the task is to inspect the live running sandbox, verify that the correct deployment is being queried, or explain slow Telegram wake/reply behavior.

### Rules of engagement

- Treat `https://vercel-openclaw.labs.vercel.dev` as the canonical production alias.
- Always stay scoped to `vercel-labs`.
- Prefer explicit deployment and project identifiers from `.env.agent` over the local `.vercel/project.json` link.
- The local `.vercel/project.json` may point at a different project; do not trust it for production debugging.

### Current known-good production identifiers

- Scope/team: `vercel-labs`
- Project: `vercel-openclaw`
- Project ID: `prj_RMaYazjosJflLoZ94GrsSeVdA4Yr`
- Canonical alias: `https://vercel-openclaw.labs.vercel.dev`
- Current production deployment during this investigation:
  `dpl_9kXgMgoBKozhX6bCNdULKYJmRMb9`

### Deployment targeting: verify first

Always prove which deployment the alias currently resolves to before drawing conclusions:

```bash
vercel inspect "$OPENCLAW_BASE_URL" --scope "$OPENCLAW_SCOPE"
```

Expected during this investigation:

- deployment id `dpl_9kXgMgoBKozhX6bCNdULKYJmRMb9`
- alias includes `https://vercel-openclaw.labs.vercel.dev`

### Protected deployment access

`vercel curl` against this deployment requires the protection bypass secret, and `/api/status` also requires app auth:

```bash
vercel curl /api/health \
  --deployment "$OPENCLAW_DEPLOYMENT_ID" \
  --scope "$OPENCLAW_SCOPE" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"

vercel curl /api/status \
  --deployment "$OPENCLAW_DEPLOYMENT_ID" \
  --scope "$OPENCLAW_SCOPE" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  -- --header "Authorization: Bearer $ADMIN_SECRET"
```

Notes:

- `/api/health` does **not** require app auth, only deployment bypass.
- `/api/status` requires both deployment bypass and bearer auth.
- If you omit the bypass secret, `vercel curl` returns the Vercel Authentication HTML page.
- If you omit the bearer auth for `/api/status`, the app returns `{"error":"UNAUTHORIZED","message":"Authentication required."}`.

### What `/api/status` tells you

This is the source of truth for the app's view of the running instance.

During this investigation, `/api/status` returned:

- `status: "running"`
- `sandboxId: "oc-prj-rmayazjosjflloz94grssevda4yr"`
- `snapshotId: null`
- `openclawVersion: "OpenClaw 2026.4.11 (769908e)"`
- `restorePreparedReason: "snapshot-missing"`

Interpretation:

- The app is on a fresh running sandbox state, not an active snapshot restore.
- `snapshotId: null` after `Reset Sandbox -> Create Fresh Sandbox` is expected.
- The deployment has the current code and current metadata.

### Sandbox naming vs CLI listing

This repo uses a persistent sandbox **name** derived from the instance/project id:

```ts
const sandboxName = `oc-${current.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
```

See:

- `src/server/sandbox/lifecycle.ts`
- `src/server/env.ts`
- `src/server/sandbox/controller.ts`

Important:

- The app stores and reports sandbox identifiers as the persistent sandbox **name** (for example `oc-prj-rmayazjosjflloz94grssevda4yr`).
- The Sandbox CLI `ls` table may show `sbx_*` identifiers instead.
- Do **not** assume the app-reported `sandboxId` will look like the `sbx_*` values shown by `npx sandbox ls`.
- In this codebase, `controller.ts` wraps the SDK so `sandboxId` maps to `sandbox.name`, and `get()` resolves by `name`.

### Sandbox CLI commands

Use the real project id explicitly:

```bash
npx sandbox ls --all --scope "$OPENCLAW_SCOPE" --project "$OPENCLAW_PROJECT_ID"
npx sandbox snapshots list --scope "$OPENCLAW_SCOPE" --project "$OPENCLAW_PROJECT_ID"
```

During this investigation, the CLI inventory showed:

- stopped sandbox `sbx_XXUSKPHfHQi9INydOSzUdC1gLg9h` from ~1 day ago
- snapshot `snap_c655pK7fMZsdAayHdX9xESDIvmP5`

That older snapshot was a real Vercel Sandbox snapshot object, but it was **not** the same identifier as the app's persistent sandbox name.

### Telegram wake investigation

When investigating Telegram wake-from-sleep latency, use the app's diagnostic endpoint first:

```bash
vercel curl /api/admin/channel-forward-diag \
  --deployment "$OPENCLAW_DEPLOYMENT_ID" \
  --scope "$OPENCLAW_SCOPE" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  -- --header "Authorization: Bearer $ADMIN_SECRET"
```

This returns the most recent workflow diagnostic written by `drain-channel-workflow.ts`.

The most useful fields are:

- `receivedAtMs`
- `workflowStartedAt`
- `bootDurationMs`
- `sandboxReadyAt`
- `telegramProbeAttempts`
- `telegramProbeWaitMs`
- `telegramProbeLastStatus`
- `forwardDurationMs`
- `forwardAttempts`
- `forwardRetries`
- `forwardTotalMs`
- `totalDurationMs`

### What we learned about Telegram slow replies

The most recent Telegram wake diagnostic showed:

- boot/restore to ready: about `19.65s`
- Telegram probe wait: about `10.04s`
- forward duration: about `27.28s`
- retrying forward total: about `17.23s`
- total end-to-end: about `47.19s`

Most important finding:

- The dominant delay after sandbox restore was **post-restore Telegram handler readiness**, not the restore copy/label fix.
- The workflow retried multiple times with reason `swallowed-by-base-server`.
- The Telegram probe ended with `lastStatus: 200`, which indicates the base server was answering before the Telegram native handler route was actually ready.

In other words:

- sandbox became "running"
- gateway was up
- but `/telegram-webhook` on port `8787` was still not truly ready
- several forwards were swallowed before one finally landed

### Logs endpoint: when to use it

The admin logs endpoint is still useful, but it is not guaranteed to retain the Telegram event you care about. Use it for immediate debugging, not as the only source of truth:

```bash
vercel curl '/api/admin/logs?channel=telegram' \
  --deployment "$OPENCLAW_DEPLOYMENT_ID" \
  --scope "$OPENCLAW_SCOPE" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  -- --header "Authorization: Bearer $ADMIN_SECRET"
```

Useful searches:

- `channels.telegram_webhook_accepted`
- `channels.telegram_boot_message_sent`
- `channels.workflow_sandbox_ready`
- `channels.workflow_native_forward_result`
- `channels.telegram_wake_summary`
- `sandbox.create.persistent_resume`
- `sandbox.create.persistent_resume.complete`
- `sandbox.restore.metrics`

If `logs` comes back empty but the wake just happened, check `/api/admin/channel-forward-diag` instead; that endpoint is often more reliable for the latest Telegram wake.

### Verifying the restore-copy patch specifically

The restore-copy patch changed wake flows so snapshot/persistent resume paths surface restore-oriented state instead of briefly showing create-oriented copy.

Relevant files:

- `src/server/sandbox/lifecycle.ts`
- `src/server/sandbox/lifecycle.test.ts`
- `src/server/channels/core/boot-messages.test.ts`

Current patch behavior:

- restore scheduling now surfaces `restoring`
- progress uses `resuming-sandbox`
- copy should read restore-oriented text
- only if resume falls back to real create should it switch to create wording

To verify the patch in production:

1. Stop the running sandbox so the next message must wake it.
2. Trigger Telegram.
3. Capture `/api/admin/channel-forward-diag` and `/api/admin/logs`.
4. Confirm the lifecycle/progress path is restore-oriented.
5. If the reply is still slow, check whether the delay is restore itself or the Telegram native handler registration lag on port `8787`.

---

## Quick Reference

```bash
# Canonical local verification (use this for CI and agent verification)
node scripts/verify.mjs                                     # all gates
node scripts/verify.mjs --steps=test                        # test only
node scripts/verify.mjs --steps=lint                        # lint only
node scripts/verify.mjs --steps=typecheck                   # typecheck only
node scripts/verify.mjs --steps=build                       # build only
node scripts/verify.mjs --steps=test,typecheck              # multiple steps

# Direct pnpm shortcuts (convenience only — prefer verify.mjs for automation)
pnpm test                                                    # all tests
pnpm test:watch                                              # watch mode

# Remote diagnostics (read .env.agent first for OPENCLAW_BASE_URL and ADMIN_SECRET)
# source .env.agent
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET"
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --mode destructive
pnpm smoke:remote --base-url "$OPENCLAW_BASE_URL" --destructive --timeout 180
node scripts/test-telegram-wake.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET"

# Local public-webhook reproduction with vgrok
# Uses a sanitized .env.local, unique OPENCLAW_INSTANCE_ID, next dev, vgrok, and the same Telegram wake script via the public tunnel
pnpm test:telegram-wake-local -- --timeout 180

# Ad-hoc endpoint checks
vercel curl /api/health --deployment "$OPENCLAW_BASE_URL"
vercel curl /api/status --deployment "$OPENCLAW_BASE_URL"
vercel curl /api/admin/preflight --deployment "$OPENCLAW_BASE_URL"
vercel curl /api/admin/logs?level=error --deployment "$OPENCLAW_BASE_URL"
vercel curl /api/admin/channels/health --deployment "$OPENCLAW_BASE_URL"

# Benchmarking
node scripts/benchmark-restore.mjs --base-url "$OPENCLAW_BASE_URL" --cycles 5 --vcpus 1,2,4
node scripts/bench-sandbox-direct.mjs --cycles 5 --vcpus 1,2,4

# Operational
node scripts/reset-meta.mjs                                 # reset Redis metadata to uninitialized
node scripts/check-queue-consumers.mjs                      # verify vercel.json queue consumer routes
node scripts/audit-verifier-surface.mjs                     # audit protected route manifest
```

## Remote Deployment Readiness Gate

Before connecting Slack, Telegram, or Discord, verify the deployment meets the launch contract.

```bash
# Full launch verification (default): preflight + queue probe + sandbox ensure + chat completions + wake-from-sleep
node scripts/check-deploy-readiness.mjs \
  --base-url "$OPENCLAW_BASE_URL" \
  --admin-secret "$ADMIN_SECRET" \
  --json-only

# Destructive mode: includes sandbox lifecycle operations
node scripts/check-deploy-readiness.mjs \
  --base-url "$OPENCLAW_BASE_URL" \
  --admin-secret "$ADMIN_SECRET" \
  --mode destructive \
  --json-only

# Lightweight config-only check (no runtime behavior)
node scripts/check-deploy-readiness.mjs \
  --base-url "$OPENCLAW_BASE_URL" \
  --admin-secret "$ADMIN_SECRET" \
  --preflight-only \
  --json-only

# With deployment protection bypass instead of admin secret
node scripts/check-deploy-readiness.mjs \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json-only
```

**Flags:**
- `--base-url` (required) — deployed app URL
- `--admin-secret` — bearer token auth (mutually exclusive with `--auth-cookie`)
- `--auth-cookie` — session cookie auth (mutually exclusive with `--admin-secret`)
- `--protection-bypass` — Vercel deployment protection bypass secret
- `--mode safe|destructive` — `safe` (default) or `destructive` (includes sandbox lifecycle)
- `--preflight-only` — skip launch-verify, only check `/api/admin/preflight`
- `--expect-store redis` — expected store backend (default: `redis`)
- `--expect-ai-gateway-auth oidc` — expected auth mode (default: `oidc`)
- `--timeout-ms` — overall timeout in ms (default: 180000)
- `--json-only` — suppress stderr, JSON to stdout only

**Exit codes:** 0=pass, 1=contract-fail, 2=bad-args, 3=fetch-fail, 4=bad-response.

**Rule: Do not connect channels until the readiness verifier exits 0.**

## Remote Smoke Testing (Live Deployment)

Run smoke tests only after the readiness gate passes. All secrets must come from environment variables.

```bash
# Safe read-only smoke test
pnpm smoke:remote \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"

# Destructive smoke test (includes ensure, snapshot, restore, self-heal — use with caution)
pnpm smoke:remote \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --destructive --timeout 180

# JSON-only output (for CI)
pnpm smoke:remote \
  --base-url "$OPENCLAW_BASE_URL" \
  --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json-only
```

**Auth flags:**
- `--protection-bypass` — reads from flag or `VERCEL_AUTOMATION_BYPASS_SECRET` env var

## Local Telegram Wake Testing via `vgrok`

Use this when you want the most realistic local reproduction of Telegram wake-from-sleep behavior without pointing Telegram at production.

What the local harness does:

1. Backs up `.env.local`
2. Removes Vercel deployment markers like `VERCEL_ENV` and `VERCEL_URL` so local Next.js does not enter the deployed-Vercel codepath
3. Preserves sandbox credentials like `VERCEL_OIDC_TOKEN` so the app can still talk to `@vercel/sandbox`
4. Sets a unique `OPENCLAW_INSTANCE_ID` so the local run does not reuse the production persistent sandbox name
5. Starts `next dev`
6. Starts `vgrok`
7. Runs the same `scripts/test-telegram-wake.mjs` script through the public `vgrok` URL
8. Restores `.env.local` afterward

Command:

```bash
pnpm test:telegram-wake-local -- --timeout 180
```

Important notes:

- The local harness intentionally sends admin requests through the `vgrok` URL, not `localhost`. That lets `buildPublicUrl()` derive the public host from the incoming request, so `NEXT_PUBLIC_APP_URL` is not required for the test.
- If Telegram is not configured, `scripts/test-telegram-wake.mjs` will auto-configure smoke test channel credentials through `PUT /api/admin/channel-secrets` and remove them afterward.
- The local run still needs a usable sandbox credential. In practice that means preserving `VERCEL_OIDC_TOKEN` in `.env.local` or setting `AI_GATEWAY_API_KEY`.
- `--auth-cookie` — reads from flag or `SMOKE_AUTH_COOKIE` env var
- **Never commit or hardcode secrets in docs, code samples, or tests**

### Remote Smoke Phases

**Safe phases (always run):**

| Phase | Endpoint | What it verifies |
|-------|----------|-----------------|
| `health` | `GET /api/health` | Basic 200 + `ok: true` |
| `status` | `GET /api/status` | Status field, authMode, storeBackend present |
| `gatewayProbe` | `GET /gateway` | 200 with `openclaw-app` marker OR 202 waiting page |
| `firewallRead` | `GET /api/firewall` | Mode and allowlist fields present |
| `channelsSummary` | `GET /api/channels/summary` | Channel connectivity info |
| `sshEcho` | `POST /api/admin/ssh` | Runs `echo smoke-ok`, validates output |
| `chatCompletions` | `POST /gateway/v1/chat/completions` | LLM roundtrip (60s timeout) |
| `channelRoundTrip` | `POST /api/admin/channel-secrets` | Server-signed synthetic webhooks for Slack/Telegram/Discord, polls for queue drain |

**Destructive phases (opt-in with `--destructive`):**

| Phase | Endpoint | What it verifies |
|-------|----------|-----------------|
| `ensureRunning` | `POST /api/admin/ensure` | Sandbox create or restore, polls until running |
| `channelWakeFromSleep` | `POST /api/admin/snapshot` + webhook | Stops sandbox, sends webhook, verifies wake-up recovery + queue drain |
| `selfHealTokenRefresh` | `POST /api/admin/ssh` + completions | Corrupts gateway token via SSH, sends channel webhook, verifies self-healing recovery |

---

## Production Debugging Playbook

### Debug Routes (gated by `ENABLE_DEBUG_ROUTES=1`)

All debug routes require the `ENABLE_DEBUG_ROUTES` env var to be set. They return 404 in production unless explicitly enabled. All are `POST` endpoints.

| Route | Purpose | When to use |
|-------|---------|-------------|
| `/api/debug/restore-waterfall` | Full restore profiling with per-phase waterfall timings (stop, metadata, credentials, config, create, assets, readiness, snapshot) | Investigating slow restores — shows exactly which phase is the bottleneck |
| `/api/debug/pre-create-timing` | Measures config/policy building time before sandbox creation (gateway config, asset manifest, network policy) | Investigating whether pre-create overhead is contributing to restore latency |
| `/api/debug/sandbox-timing` | Direct `@vercel/sandbox` SDK timing (create, echo, sh-exit, sh-sleep, snapshot). Requires `snapshotId` query param or `DEBUG_SANDBOX_SNAPSHOT_ID` env | Isolating platform-level latency from app-level overhead |
| `/api/debug/cold-start` | Detects cold start vs warm start, measures module-to-handler time | Investigating intermittent slowness that could be cold start related |
| `/api/debug/store-timing` | Measures Redis store read/write latency | Investigating store-related slowness (metadata reads, queue operations) |
| `/api/debug/oidc-timing` | Measures AI Gateway OIDC token acquisition time | Investigating gateway auth latency or token fetch failures |
| `/api/debug/lock-timing` | Tests distributed lock acquisition/release latency | Investigating queue drain contention or concurrent lifecycle operations |
| `/api/debug/sdk-import-timing` | Measures `import("@vercel/sandbox")` time | Investigating cold start — SDK import is a significant contributor |
| `/api/debug/after-timing` | Tests `after()` scheduler latency | Investigating delayed lifecycle transitions (ensure/stop scheduled via `after()`) |

### Admin Diagnostic Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/preflight` | GET | Deployment readiness config check — authMode, publicOrigin, storeBackend, aiGatewayAuth, channel connectability, webhook diagnostics |
| `/api/admin/launch-verify` | POST | Full launch verification — preflight + queue probe + sandbox ensure + chat completions + wake-from-sleep + self-heal token refresh |
| `/api/admin/logs` | GET | Server logs + sandbox logs with correlation filters (see below) |
| `/api/admin/watchdog` | GET/POST | Sandbox health monitoring — GET reads cached report, POST runs fresh check (readiness, gateway, timeout validation) |
| `/api/admin/ssh` | POST | Execute shell commands in the running sandbox. Body: `{ "command": "ps aux" }` |
| `/api/admin/channels/health` | GET | Channel queue health — queue depth, failed counts, last errors for all channels |
| `/api/channels/summary` | GET | Channel delivery state — queue depths, config status, connectivity |
| `/api/firewall/diagnostics` | GET | Detailed firewall state — learning logs, extracted domains, inferred vs configured allowlist |
| `/api/status` | GET | Full metadata snapshot including `lifecycle` block (see below). Add `?health=1` for live gateway probe |

### Log Endpoint Filters (`GET /api/admin/logs`)

The logs endpoint merges server ring buffer logs with sandbox OpenClaw logs (read from `setup`, `booting`, `restoring`, and `running` states — NOT `stopped`). All filters use AND logic when combined.

| Query Param | Purpose | Example |
|-------------|---------|---------|
| `?level=` | Filter by log level | `?level=error` |
| `?source=` | Filter by source module | `?source=lifecycle`, `?source=channels`, `?source=auth` |
| `?search=` | Free-text search in message | `?search=token` |
| `?opId=` | Filter by operation ID (matches both `opId` and `parentOpId`) | `?opId=op_abc123` |
| `?requestId=` | Filter by Vercel request ID (`x-vercel-id`) | `?requestId=iad1::xxxxx` |
| `?channel=` | Filter by channel (slack/telegram/discord) | `?channel=slack` |
| `?sandboxId=` | Filter by sandbox ID | `?sandboxId=sbx-abc` |
| `?messageId=` | Filter by message ID | `?messageId=msg_123` |

The response includes a `diagnostics` block reporting sandbox log collection status:

```json
{
  "logs": [...],
  "diagnostics": {
    "serverLogCount": 42,
    "sandboxLogCount": 15,
    "totalLogCount": 57,
    "sandbox": {
      "attempted": true,
      "included": true,
      "status": "running",
      "sandboxId": "sbx-abc",
      "tailError": null,
      "parsedLineCount": 200,
      "matchedLineCount": 15
    },
    "filters": { "level": "error", "source": "channels" }
  }
}
```

### Status Endpoint Lifecycle Block (`GET /api/status`)

The status response includes a `lifecycle` block with token refresh and restore metrics:

```json
{
  "status": "running",
  "lifecycle": {
    "lastRestoreMetrics": {
      "sandboxCreateMs": 1200,
      "tokenWriteMs": 50,
      "assetSyncMs": 300,
      "startupScriptMs": 800,
      "localReadyMs": 2000,
      "publicReadyMs": 500,
      "totalMs": 5200,
      "skippedStaticAssetSync": true,
      "vcpus": 2
    },
    "restoreHistory": [{ "totalMs": 5200, "recordedAt": 1710000000 }],
    "lastTokenRefreshAt": 1710000000,
    "lastTokenSource": "oidc",
    "lastTokenExpiresAt": 1710043200,
    "lastTokenRefreshError": null,
    "consecutiveTokenRefreshFailures": 0,
    "breakerOpenUntil": null
  }
}
```

Use `lifecycle.consecutiveTokenRefreshFailures > 0` or `lifecycle.breakerOpenUntil != null` to detect token refresh circuit breaker activation.

### Observability Infrastructure

The project uses structured operation contexts for end-to-end request tracing across webhook ingress → queue → processing → gateway → platform reply.

**Operation Context** (`src/server/observability/operation-context.ts`):
- `createOperationContext()` — creates unique `opId` for tracing through logs
- Every log entry can include: `opId`, `parentOpId`, `requestId`, `channel`, `sandboxId`, `messageId`
- Webhook routes extract `requestId` from `x-vercel-id` / `x-request-id` headers and thread it through queue jobs
- Queue consumers link to webhook via `parentOpId = job.opId`

**State Snapshots** (`src/server/observability/state-snapshot.ts`):
- `logStateSnapshot()` — captures structured state at key transitions
- Includes: status, sandboxId, snapshotId, lastError, queue depths (queued vs processing)

**Key Log Events by Subsystem:**

| Subsystem | Log Event | What It Tells You |
|-----------|-----------|-------------------|
| **Channel Webhooks** | `channels.slack_webhook_accepted` | Webhook received and validated |
| | `channels.*_fast_path_ok` | Queue publish succeeded via Vercel Queues |
| | `channels.*_fast_path_failed` | Queue publish failed — fell back to store-based queue |
| | `channels.*_webhook_fallback_enqueue` | Fallback enqueue to store-based queue |
| **Channel Queue** | `channels.job_leased` | Job taken from queue (includes queue depth) |
| | `channels.job_acked` | Job processed successfully |
| | `channels.job_ack_missing` | Ack failed — job may be reprocessed |
| | `channels.job_parked` | Job deferred for later processing (includes `nextAttemptAt`) |
| | `channels.job_retry_parked` | Retryable error — job rescheduled |
| | `channels.job_retry_park_failed` | Failed to reschedule — job may be lost |
| **Sandbox Lifecycle** | `sandbox.status_transition` | Status changed (e.g., creating → setup → running) |
| | `sandbox.restore.fast_restore_result` | Startup script completed (exitCode, stdout/stderr head, timing) |
| | `sandbox.restore.fast_restore_failed` | Startup script errored (exitCode, stderr head) |
| | `sandbox.restore.local_ready_report` | Parsed readiness JSON (ready, attempts, readyMs) |
| | `sandbox.create.complete` | Create/restore finished with operation context |
| | `sandbox.mark_unavailable_skipped_stale` | Stale worker tried to clear state — safely skipped |
| **Auth Recovery** | `gateway.auth_failure_detected` | 401/403/410 from gateway |
| | `gateway.auth_refresh_attempted` | Token refresh cycle started |
| | `gateway.auth_refresh_succeeded` | New token acquired and written |
| | `gateway.auth_retry_result` | Result of retried request after refresh |

**Tracing a channel message end-to-end:**
1. Filter by `?requestId=<x-vercel-id>` to find the webhook ingress log
2. Get the `opId` from that log entry
3. Filter by `?opId=<opId>` to see all logs for that operation (including queue consumer via `parentOpId`)
4. If the message hit the gateway, the `channels.job_acked` log will include the gateway response status

### SSH Sandbox Inspection Recipes

Use `/api/admin/ssh` (POST with `{ "command": "..." }`) for interactive debugging:

```bash
# Check if gateway process is running (note: argv rewrites to "openclaw-gateway" with hyphen)
ps aux | grep openclaw

# Read the current gateway token file
cat /root/.openclaw/gateway-token

# Read the AI Gateway key file
cat /root/.openclaw/ai-gateway-key

# Check OpenClaw logs
tail -100 /root/.openclaw/logs/openclaw.log

# Check what ports are listening
ss -tlnp

# Inspect environment variables (look for stale baked-in tokens)
env | grep -i gateway

# Check if the startup script is present and correct
cat /root/.openclaw/startup.sh

# Test gateway health from inside the sandbox
curl -s http://localhost:3000/ | head -20

# Check disk space (large npm installs can fill the sandbox)
df -h
```

### Operational Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/verify.mjs` | Master verification harness — runs contract, lint, test, typecheck, build gates | `node scripts/verify.mjs --steps=test,typecheck` |
| `scripts/check-deploy-readiness.mjs` | Machine-readable deployment readiness gate | See [Remote Deployment Readiness Gate](#remote-deployment-readiness-gate) |
| `scripts/benchmark-restore.mjs` | Repeated snapshot/stop → ensure cycles with per-phase waterfall timings | `node scripts/benchmark-restore.mjs --base-url "$URL" --cycles 5 --vcpus 1,2,4` |
| `scripts/bench-sandbox-direct.mjs` | Direct `@vercel/sandbox` SDK benchmark (no HTTP layer) — create → install → snapshot → restore loop | `node scripts/bench-sandbox-direct.mjs --cycles 5 --vcpus 1,2,4` |
| `scripts/reset-meta.mjs` | Reset Redis metadata to `uninitialized` — clears sandboxId, snapshotId, status, lastError, portUrls | `node scripts/reset-meta.mjs` (reads `.env.local` for `REDIS_URL`) |
| `scripts/check-queue-consumers.mjs` | Verify Vercel Queue consumer routes are declared in `vercel.json` | `node scripts/check-queue-consumers.mjs` |
| `scripts/audit-verifier-surface.mjs` | Audit that protected route manifest is consistent | `node scripts/audit-verifier-surface.mjs` |
| `scripts/check-verifier-contract.mjs` | Ensure deployment contract env vars are documented in README, CLAUDE.md, CONTRIBUTING.md, .env.example | `node scripts/check-verifier-contract.mjs` |
| `scripts/generate-protected-route-manifest.mjs` | Security audit: detects `MISSING_AUTH_GATE` and `MISSING_DEBUG_GUARD` violations. Use `--check` for CI validation | `node scripts/generate-protected-route-manifest.mjs --check` |

---

## Known Failure Patterns

These patterns are distilled from 100+ commits of production fixes. When investigating an issue, check if it matches one of these categories first.

### 1. OIDC Token Expiry (Gateway Auth Failures)

**Symptoms:** Gateway returns 401/403 after running for ~12 hours. Channel messages fail silently. Chat completions through `/gateway/v1/chat/completions` return auth errors.

**Root causes found historically:**
- Gateway proxy never called `ensureFreshGatewayToken()` — only the channel driver path had refresh logic. Direct chat UI requests failed after token expired.
- `pkill` pattern used `"openclaw gateway"` with a space, but the binary rewrites its argv to `"openclaw-gateway"` with a hyphen — process never restarted. **Fix:** use regex `"openclaw.gateway"` to match both.
- Sandbox environment bakes `AI_GATEWAY_API_KEY` immutably at create time. Writing a new token file is insufficient if the startup script's env var check takes precedence. **Fix:** use `env -u AI_GATEWAY_API_KEY` before restart.
- After startup script restarts gateway during token refresh, app immediately tried to call gateway before it finished booting → 500 errors. **Fix:** poll for local readiness (`curl localhost:3000`) before returning from refresh.
- Token refresh was restarting gateway every 5 minutes even when token hadn't changed, causing Telegram messages to hit a dead gateway mid-restart. **Fix:** read current token from sandbox before restarting; skip if unchanged.

**Key files:** `src/server/gateway/auth-recovery.ts`, `src/server/openclaw/bootstrap.ts`

**How to test for this:** The remote smoke `selfHealTokenRefresh` phase corrupts the gateway token via SSH and verifies self-healing recovery. Locally, `drain-auth-decay.test.ts` tests auth token expiry during drain.

### 2. Telegram Webhook Deadlocks

**Symptoms:** Telegram messages stop being delivered. `setWebhook` succeeds but messages never arrive. Queue depth grows but never drains.

**Root causes found historically:**
- Startup scripts called `deleteWebhook` on every sandbox boot, clearing the webhook URL. Old snapshots contained these scripts, and new scripts weren't synced fast enough after restore. **Fix:** remove `deleteWebhook` from startup scripts entirely.
- Telegram's `setWebhook` API was previously believed to reject URLs with query parameters, but testing confirmed it preserves them. All channels now use `buildPublicUrl` with the bypass param.
- Queue publish failures on webhook route returned 500 to Telegram, which then exponentially backed off webhook deliveries (Telegram reduces delivery frequency on repeated failures). **Fix:** always return 200 from webhook route, even on internal errors.
- Reconnecting Telegram created backlogged failed updates that prevented new webhook delivery. **Fix:** pass `drop_pending_updates: true` to `setWebhook`.

**Key files:** `src/server/channels/telegram/bot-api.ts`, `src/server/channels/state.ts`, `src/server/openclaw/bootstrap.ts`

**How to test for this:** Check `/api/admin/channels/health` for Telegram queue depth. Use `/api/admin/ssh` to verify webhook URL with `curl` to Telegram API. The `channelRoundTrip` smoke phase verifies end-to-end delivery.

### 3. Sandbox API Asymmetries (Create vs Restore)

**Symptoms:** Sandbox operations return 400 errors. Sandbox stuck in `restoring` or `error` status. Works on fresh create but fails on snapshot restore.

**Root causes found historically:**
- `networkPolicy` parameter accepted on `create()` but rejected on snapshot `restore()` with 400. **Fix:** apply firewall policy post-create via `updateNetworkPolicy()` instead of at create time.
- Base64-encoded content in sandbox environment variables triggers 400 from the API. **Fix:** use `writeFiles` for config delivery instead of env vars.
- OpenClaw now validates that `dmPolicy="open"` has matching `allowFrom: ["*"]`. Without it, gateway refuses to start. **Fix:** always include both fields in config.

**Key files:** `src/server/sandbox/lifecycle.ts`, `src/server/firewall/policy.ts`, `src/server/openclaw/config.ts`

**How to test for this:** The `restore-waterfall` debug route isolates each phase. Check `lastRestoreMetrics` in `/api/status` response for per-phase timing. The full smoke test Phase 6 exercises channel-triggered restore.

### 4. Restore Hot Path Timing Races

**Symptoms:** Intermittent restore failures. Gateway not ready after restore completes. Restore metrics show inconsistent timing.

**Root causes found historically:**
- Host-side HTTP probes and sandbox-side `runCommand("curl")` probes have different failure modes. Host-side probes can fail due to DNS/proxy issues even when sandbox is ready internally.
- Overlapping `after()` callbacks from concurrent requests can trigger multiple restores simultaneously.
- Gateway process hasn't finished booting when first request arrives after restore.

**Key files:** `src/server/sandbox/lifecycle.ts`, `src/server/openclaw/restore-assets.ts`

**How to test for this:** Run `scripts/benchmark-restore.mjs` with multiple cycles. Use the `restore-waterfall` debug route for per-phase breakdown. `concurrency-smoke.test.ts` tests simultaneous restore attempts.

### 5. Template/Shell Script Escaping

**Symptoms:** Build failures, sandbox bootstrap failures, `SyntaxError` in startup scripts.

**Root causes found historically:**
- TypeScript template literals interpret `${tg_token}` as JS template interpolation instead of shell variable reference — breaks the build. **Fix:** escape with backslash: `\${tg_token}`.
- Shell `pkill` pattern matching is fragile when binaries rewrite their argv (e.g., `openclaw gateway` → `openclaw-gateway`). **Fix:** use regex patterns.

**Key files:** `src/server/openclaw/bootstrap.ts` (startup script generation), `src/server/openclaw/restore-assets.ts`

**How to test for this:** The build gate (`pnpm build`) catches template literal issues. Bootstrap tests in `bootstrap.test.ts` verify generated script content.

### 6. Gateway Configuration Drift

**Symptoms:** Gateway refuses to start after config changes. Device auth prompts appear in proxied UI. Gateway ignores new tokens.

**Root causes found historically:**
- `dangerouslyDisableDeviceAuth` was re-enabled in config, causing device-level auth prompts that conflict with proxy auth. **Fix:** always set `dangerouslyDisableDeviceAuth: true`.
- Gateway token was passed as query params (`?token=xxx`) but OpenClaw reads from URL hash fragment (`#token=xxx`). **Fix:** use hash fragment delivery.
- Injected script stripped token from URL too early (on `DOMContentLoaded`), before React app's `useEffect` could read it asynchronously. **Fix:** poll localStorage for app settings key to detect consumption, then strip.

**Key files:** `src/server/openclaw/config.ts`, `src/server/proxy/htmlInjection.ts`

**How to test for this:** `config.test.ts` verifies config generation. `htmlInjection.test.ts` verifies injection markers and timing. Smoke test Phase 3 checks proxy verification end-to-end.

---

## Remote Debugging Workflows

Step-by-step investigation playbooks for common production issues.

### "Channel messages aren't being delivered"

1. **Check channel health:** `GET /api/admin/channels/health` — look for non-zero `failedCount` or `lastError`
2. **Check queue depth:** `GET /api/channels/summary` — non-zero `queueDepth` means messages are stuck
3. **Check queue processing:** `GET /api/admin/logs?channel=slack` (or telegram/discord) — filter logs to the specific channel
4. **Trace a specific message:** If you have the `x-vercel-id` from the webhook request, use `GET /api/admin/logs?requestId=<id>` to find the webhook ingress, then use the `opId` from that log to trace the full pipeline: `GET /api/admin/logs?opId=<opId>`
5. **Check for fast-path failures:** Search for `fast_path_failed` — this means Vercel Queues rejected the publish and the system fell back to store-based queuing
6. **Check for job parking:** Search for `job_parked` or `job_retry_parked` — these indicate deferred or retrying jobs with `nextAttemptAt` timestamps
7. **Check gateway token:** `GET /api/status` — look at `lifecycle.consecutiveTokenRefreshFailures` and `lifecycle.breakerOpenUntil` for token refresh circuit breaker state
8. **Check webhook URL:** For Telegram, verify the registered URL via `getWebhookInfo` matches the expected delivery URL
9. **Trigger self-heal:** Run destructive smoke with `selfHealTokenRefresh` phase, or `POST /api/admin/launch-verify` with destructive mode

### "Sandbox stuck in restoring/error"

1. **Check status:** `GET /api/status` — look at `status`, `lastError`, `lifecycle.lastRestoreMetrics` for per-phase timing
2. **Check lifecycle logs:** `GET /api/admin/logs?source=lifecycle&level=error` — look for `sandbox.status_transition`, `sandbox.restore.fast_restore_failed`, `sandbox.restore.local_ready_report`
3. **Check restore script output:** Search logs for `sandbox.restore.fast_restore_result` — includes `exitCode`, `stdoutHead` (500 chars), `stderrHead` (500 chars), and `startupScriptMs` timing
4. **Check for stale worker interference:** Search for `sandbox.mark_unavailable_skipped_stale` — this means a late worker tried to clear state after another worker already replaced it (concurrency-safe, but indicates contention)
5. **Run restore waterfall:** `POST /api/debug/restore-waterfall` — per-phase timing breakdown shows the exact bottleneck
6. **Inspect via SSH:** `POST /api/admin/ssh` — check process list, logs, disk space. Note: sandbox logs are also available via `GET /api/admin/logs` for `setup`, `booting`, and `restoring` states (not just `running`)
7. **Check for API asymmetries:** If restoring from snapshot, try fresh create (`POST /api/admin/ensure`) — if create works but restore doesn't, it's likely a create-vs-restore API difference
8. **Reset metadata:** If stuck, use `scripts/reset-meta.mjs` to clear state and retry

### "Gateway returning 401/403"

1. **Check token refresh state:** `GET /api/status` — look at `lifecycle.lastTokenRefreshAt`, `lifecycle.lastTokenRefreshError`, `lifecycle.consecutiveTokenRefreshFailures`, `lifecycle.breakerOpenUntil`
2. **Check OIDC timing:** `POST /api/debug/oidc-timing` — if slow or failing, OIDC provider may be down
3. **Trace auth recovery logs:** `GET /api/admin/logs?search=auth_failure` — look for `gateway.auth_failure_detected`, `gateway.auth_refresh_attempted`, `gateway.auth_refresh_succeeded`, `gateway.auth_retry_result`
4. **Inspect token file:** SSH `cat /root/.openclaw/ai-gateway-key` — check if token looks fresh
5. **Check env immutability:** SSH `env | grep -i gateway` — if baked-in env var differs from token file, the startup script may be overriding
6. **Check for 410 preservation:** Auth recovery now preserves the original HTTP status code (401/403/410) when refresh fails — look for `firstResponseStatus` in logs to distinguish "never had a valid token" from "token expired mid-session"
7. **Trigger launch-verify:** `POST /api/admin/launch-verify` — its `selfHealTokenRefresh` phase tests the full refresh cycle
8. **Manual refresh:** If needed, stop and ensure to force fresh bootstrap: `POST /api/admin/stop` → `POST /api/admin/ensure`

### "Slow restores"

1. **Run benchmark:** `node scripts/benchmark-restore.mjs --base-url "$URL" --cycles 3 --vcpus 1,2,4` — compare across vCPU configurations
2. **Check waterfall:** `POST /api/debug/restore-waterfall` — per-phase timing breakdown shows the bottleneck
3. **Check asset sync:** Look at `lastRestoreMetrics.skippedStaticAssetSync` in `/api/status` — if `false`, static assets are being redundantly rewritten
4. **Check cold start:** `POST /api/debug/cold-start` — cold start adds SDK import + module load overhead
5. **Compare SDK overhead:** `POST /api/debug/sdk-import-timing` — measures raw SDK import cost
6. **Direct SDK benchmark:** `node scripts/bench-sandbox-direct.mjs --cycles 5` — isolates platform latency from app overhead

### "Firewall learning not working"

1. **Check firewall state:** `GET /api/firewall` — verify mode is `learning`
2. **Check diagnostics:** `GET /api/firewall/diagnostics` — shows extracted domains, inferred vs configured allowlist
3. **Check learning log:** SSH `cat /tmp/shell-commands-for-learning.log` — verify commands are being captured
4. **Inspect sandbox:** SSH `ps aux` — verify shell hook is installed that writes to the learning log
5. **Check startup script:** SSH `cat /root/.openclaw/startup.sh` — verify learning hooks are present

---

## Test Framework

- **Runner:** `node:test` (Node.js built-in)
- **Assertions:** `node:assert/strict`
- **Transpiler:** `tsx` (TypeScript execution)
- **NO Jest, NO Vitest** — native Node testing only
- **Test command:** `pnpm test` or `node scripts/verify.mjs --steps=test`
- **Imports:** `@/` path alias (mapped to `src/` in tsconfig)

Tests are **colocated** with source files. Route tests live next to route files. Server tests live next to server modules. The full smoke test lives at `src/server/smoke/full-smoke.test.ts`.

---

## Scenario Harness

The harness (`src/test-utils/harness.ts`) is the central test scaffold. It wires together a fake sandbox controller, fake fetch, isolated store, log collector, and env overrides.

### `createScenarioHarness(options?)`

```typescript
import { createScenarioHarness } from "@/test-utils/harness";

const h = createScenarioHarness();
try {
  // h.controller  — FakeSandboxController
  // h.fakeFetch   — FakeFetch (intercepts all network calls)
  // h.log         — LogCollector (structured logs for observability)
  // h.getMeta()   — read current SingleMeta from store
  // h.mutateMeta  — mutate metadata in store
  // h.getStore    — get the store instance
  // h.captureState() — snapshot of current state for assertions
  // h.teardown()  — reset singletons, env, store
} finally {
  h.teardown();
}
```

**Options:**
- `controllerDelay?: number` — ms delay for fake sandbox operations
- `authMode?: 'deployment-protection' | 'sign-in-with-vercel' | 'none'`

### `withHarness(fn, options?)`

Convenience wrapper with auto-teardown:

```typescript
import { withHarness } from "@/test-utils/harness";

test("my scenario", () =>
  withHarness(async (h) => {
    h.fakeFetch.onGet(/openclaw-app/, () => gatewayReadyResponse());
    const meta = await h.getMeta();
    assert.equal(meta.status, "uninitialized");
  })
);
```

### `ScenarioHarness` Full Type

```typescript
type ScenarioHarness = {
  controller: FakeSandboxController;
  fakeFetch: FakeFetch;
  log: LogCollector;
  getMeta: () => Promise<SingleMeta>;
  mutateMeta: typeof mutateMeta;
  getStore: typeof getStore;
  captureState: () => Promise<StateSnapshot>;
  teardown: () => void;

  // Observability formatters
  formatTimeline(): string;
  formatQueues(): Promise<string>;
  formatLastRequests(n?: number): string;
  formatRecentLogs(n?: number): string;

  // Shared scenario helpers
  driveToRunning(): Promise<void>;
  stopToSnapshot(): Promise<string>;
  configureAllChannels(): ChannelSecrets;
  installDefaultGatewayHandlers(gatewayReply?: string): void;
};
```

### Shared Scenario Helpers

| Helper | Description |
|--------|-------------|
| `h.driveToRunning()` | Drives sandbox from current state to `running`. Installs gateway-ready handler, triggers `ensureSandboxRunning`, executes background callback, probes readiness. |
| `h.stopToSnapshot()` | Stops sandbox, asserts `status=stopped` and `snapshotId` present. Returns the snapshotId. |
| `h.configureAllChannels()` | Configures Slack, Telegram, Discord with test credentials. Returns `{ slackSigningSecret, telegramWebhookSecret, discordPublicKeyHex, discordPrivateKey }`. |
| `h.installDefaultGatewayHandlers(reply?)` | Registers fetch handlers for: gateway completions, all platform APIs, gateway readiness, Slack thread history. |

### Observability Formatters

| Formatter | Output |
|-----------|--------|
| `h.formatTimeline()` | Controller events + HTTP requests + log entries interleaved by timestamp |
| `h.formatQueues()` | Queue depths for all channels: `slack: queue=0 processing=0` |
| `h.formatLastRequests(n)` | Last N captured HTTP requests (method + URL + auth flag) |
| `h.formatRecentLogs(n)` | Last N log entries (level + message + data) |

### `dumpDiagnostics(t, h)` — Failure Diagnostics

Call in a `catch` block to dump full observability output via `t.diagnostic()`:

```typescript
test("my test", async (t) => {
  const h = createScenarioHarness();
  try {
    // ... test body ...
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
```

Dumps: timeline, queue depths, last 10 HTTP requests, last 30 log entries.

---

## FakeSandboxController & FakeSandboxHandle

`src/test-utils/fake-sandbox-controller.ts` provides a complete mock of the `@vercel/sandbox` API.

### FakeSandboxController

```typescript
const h = createScenarioHarness();
const ctrl = h.controller;

ctrl.created;                    // FakeSandboxHandle[] — all created handles
ctrl.retrieved;                  // string[] — all retrieved sandbox IDs
ctrl.handlesByIds;               // Map<string, FakeSandboxHandle>
ctrl.events;                     // SandboxEvent[] — ordered event log

ctrl.lastCreated();              // most recently created handle
ctrl.getHandle(sandboxId);       // get by ID (undefined if not tracked)
ctrl.eventsOfKind("create");     // filter events by kind
```

**Event Kinds:** `create` | `snapshot` | `restore` | `command` | `write_files` | `extend_timeout` | `update_network_policy`

### FakeSandboxHandle

Each handle tracks everything done to it:

```typescript
const handle = ctrl.lastCreated()!;

handle.sandboxId;               // string
handle.commands;                 // Array<{ cmd: string; args?: string[] }>
handle.writtenFiles;             // Array<{ path: string; content: Buffer }>
handle.networkPolicies;          // NetworkPolicy[]
handle.extendedTimeouts;         // number[]
handle.snapshotCalled;           // boolean

// Scripted command responses (checked in order, first non-undefined wins)
handle.responders.push((cmd, args) => {
  if (cmd === "cat") return { exitCode: 0, output: async () => "file content" };
  return undefined;
});

// Methods (all async)
await handle.runCommand("ls", ["-la"]);
await handle.writeFiles([{ path: "/tmp/test", content: Buffer.from("data") }]);
await handle.snapshot();         // Returns { snapshotId: "snap-{sandboxId}" }
await handle.extendTimeout(300_000);
await handle.updateNetworkPolicy({ allow: ["example.com"] });
```

---

## FakeFetch

`src/test-utils/fake-fetch.ts` intercepts all `globalThis.fetch` calls during tests.

### API

```typescript
const h = createScenarioHarness();
const ff = h.fakeFetch;

ff.onGet(pattern, handler);      // Register GET handler
ff.onPost(pattern, handler);     // Register POST handler
ff.onPatch(pattern, handler);    // Register PATCH handler
ff.on("PUT", pattern, handler);  // Register any method handler
ff.otherwise(handler);           // Fallback for unmatched requests
ff.requests();                   // CapturedRequest[] — all requests made
ff.reset();                      // Clear all handlers and captured requests
```

`pattern` is a `string | RegExp`. Strings match as substring. Regex matches against the full URL.

### Preset Responses

```typescript
import {
  gatewayReadyResponse,
  gatewayNotReadyResponse,
  slackOkResponse,
  telegramOkResponse,
  discordOkResponse,
  chatCompletionsResponse,
} from "@/test-utils/fake-fetch";

ff.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
ff.onPost("https://slack.com/api/chat.postMessage", () => slackOkResponse());
ff.onPost(/api\.telegram\.org/, () => telegramOkResponse());
ff.onPost(/discord\.com\/api/, () => discordOkResponse());
ff.onPost(/v1\/chat\/completions/, () => chatCompletionsResponse("Hello!"));
```

### CapturedRequest Type

```typescript
type CapturedRequest = {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
};
```

---

## Assertion Helpers

`src/test-utils/assertions.ts` provides reusable multi-step assertion functions.

### `assertGatewayRequest(requests, options)`

Assert that a `/v1/chat/completions` request was made with the correct Bearer token:

```typescript
import { assertGatewayRequest } from "@/test-utils/assertions";

const gw = assertGatewayRequest(h.fakeFetch.requests(), {
  gatewayToken: meta.gatewayToken,
  sessionKey: "slack:C123:1234.5678",  // optional
  minCalls: 1,                          // default: 1
  userMessage: "hello",                 // optional: verify last message
});
```

### `assertQueuesDrained(store, channel, options?)`

Assert queue, processing, and dead-letter queues are at expected lengths (default: 0):

```typescript
import { assertQueuesDrained } from "@/test-utils/assertions";

await assertQueuesDrained(store, "slack");
await assertQueuesDrained(store, "slack", { queue: 0, processing: 0, deadLetter: 0 });
```

### `assertHistory(history, expected)`

Assert session history contains expected messages in order:

```typescript
import { assertHistory } from "@/test-utils/assertions";

assertHistory(history, [
  { role: "user", content: "hello" },
  { role: "assistant", content: (c) => assert.ok(c.includes("Hi")) },
]);
```

### `assertNoBrowserAuthTraffic(requests)`

Assert no requests to Vercel OAuth token exchange or authorize endpoints:

```typescript
import { assertNoBrowserAuthTraffic } from "@/test-utils/assertions";

assertNoBrowserAuthTraffic(h.fakeFetch.requests());
```

---

## Route Caller Helpers

`src/test-utils/route-caller.ts` provides helpers for invoking Next.js route handlers in tests.

### Core Functions

```typescript
import {
  callRoute,
  callGatewayGet,
  callGatewayMethod,
  callAdminPost,
  drainAfterCallbacks,
  resetAfterCallbacks,
  pendingAfterCount,
  patchNextServerAfter,
} from "@/test-utils/route-caller";
```

**`patchNextServerAfter()`** — Must be called before importing route modules. Patches `next/server` so `after()` callbacks are captured instead of executed immediately.

**`callRoute(handler, request)`** — Invoke a route handler, returns:

```typescript
type RouteCallResult = {
  response: Response;
  status: number;
  json: unknown;   // parsed JSON body or null
  text: string;    // raw body text
};
```

**`drainAfterCallbacks()`** — Execute all captured `after()` callbacks. Call this after route invocations to run background work (lifecycle transitions, queue draining, etc.).

**`pendingAfterCount()`** — Number of unexecuted callbacks. Useful for asserting all background work completed.

### Request Builders

```typescript
import {
  buildGetRequest,
  buildPostRequest,
  buildPutRequest,
  buildAuthGetRequest,
  buildAuthPostRequest,
  buildAuthPutRequest,
} from "@/test-utils/route-caller";
```

- `buildGetRequest(path, headers?)` — plain GET to `http://localhost:3000`
- `buildPostRequest(path, body, headers?)` — POST with `content-type: application/json`
- `buildAuthPostRequest(path, body, headers?)` — POST with CSRF headers (`origin`, `x-requested-with`)
- `buildAuthGetRequest(path, headers?)` — GET with CSRF headers
- Auth variants add `origin: http://localhost:3000` and `x-requested-with: XMLHttpRequest`

### Lazy Route Loaders

```typescript
import {
  getGatewayRoute,
  getHealthRoute,
  getStatusRoute,
  getAdminEnsureRoute,
  getAdminStopRoute,
  getAdminSnapshotRoute,
  getAdminSnapshotsRoute,
  getAdminSshRoute,
  getAdminLogsRoute,
  getFirewallRoute,
  getFirewallTestRoute,
  getSlackWebhookRoute,
  getTelegramWebhookRoute,
  getDiscordWebhookRoute,
  getCronDrainRoute,
  getChannelsSummaryRoute,
} from "@/test-utils/route-caller";
```

These lazy-load route modules after harness setup to ensure mocks are in place.

---

## Auth Fixtures

`src/test-utils/auth-fixtures.ts` provides helpers for both auth modes.

### Session Cookie (sign-in-with-vercel mode)

```typescript
import {
  buildSessionCookie,
  setCookieToCookieHeader,
  SIGN_IN_ENV,
} from "@/test-utils/auth-fixtures";

const setCookie = await buildSessionCookie({
  user: { name: "Test User", email: "test@example.com" },
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: Date.now() + 3600_000,
});

const cookieHeader = setCookieToCookieHeader(setCookie);
const request = buildAuthGetRequest("/api/status", { cookie: cookieHeader });
```

### Deployment Protection Headers

```typescript
import {
  buildDeploymentProtectionHeaders,
  DEPLOYMENT_PROTECTION_ENV,
} from "@/test-utils/auth-fixtures";

const headers = buildDeploymentProtectionHeaders();
// { "x-vercel-protection-bypass": "true", "x-forwarded-proto": "https" }
```

### Environment Presets

```typescript
// SIGN_IN_ENV — sets VERCEL_AUTH_MODE=sign-in-with-vercel + required OAuth vars
// DEPLOYMENT_PROTECTION_ENV — sets VERCEL_AUTH_MODE=deployment-protection
```

---

## Webhook Builders

`src/test-utils/webhook-builders.ts` constructs correctly signed webhook requests for each platform.

### Slack

```typescript
import { buildSlackWebhook, buildSlackUrlVerification } from "@/test-utils/webhook-builders";

const webhook = buildSlackWebhook({
  signingSecret: "test-signing-secret",
  payload: { event: { type: "app_mention", text: "hello", channel: "C123", ts: "1234.5678" } },
});
// Returns a Request with valid x-slack-signature and x-slack-request-timestamp

const verify = buildSlackUrlVerification("test-signing-secret", "challenge-token");
```

### Telegram

```typescript
import { buildTelegramWebhook } from "@/test-utils/webhook-builders";

const webhook = buildTelegramWebhook({
  webhookSecret: "test-secret",
  payload: { message: { chat: { id: 123 }, text: "/ask hello", from: { id: 456 } } },
});
// Returns a Request with x-telegram-bot-api-secret-token header
```

### Discord

```typescript
import {
  buildDiscordWebhook,
  buildDiscordPing,
  generateDiscordKeyPair,
} from "@/test-utils/webhook-builders";

const keys = generateDiscordKeyPair();
// { privateKey: KeyObject, publicKeyHex: string }

const webhook = buildDiscordWebhook({
  privateKey: keys.privateKey,
  publicKeyHex: keys.publicKeyHex,
  payload: { type: 2, data: { name: "ask", options: [{ value: "hello" }] } },
});

const ping = buildDiscordPing(keys);
```

---

## Full Smoke Test

`src/server/smoke/full-smoke.test.ts` is the canonical end-to-end integration test. It exercises the complete lifecycle of the app in a single sequential test with 8 phases.

### Smoke Test Phases

| Phase | Name | What it verifies |
|-------|------|-----------------|
| 1 | Harness setup | All 3 channels configured, firewall set to learning mode, default gateway handlers installed |
| 2 | Fresh create + bootstrap | `uninitialized → creating → setup → running`, bootstrap artifacts written, one sandbox created |
| 3 | Proxy verification | HTML injection contains script tag, WS rewrite, heartbeat URL, base tag, referrer policy, token only inside `<script>` |
| 4 | Firewall learning + enforce | Ingest domains from learning log, approve to allowlist, switch to enforcing, network policy applied to sandbox |
| 5 | Snapshot stop | `running → stopped`, snapshotId present with `snap-` prefix, snapshot history updated, controller events correct |
| 6 | Channel-triggered restore | Slack+Telegram enqueued while stopped, Slack drain triggers exactly one restore, Telegram drain reuses running sandbox, both queues clean |
| 7 | Already-running Discord | Discord enqueued and drained without triggering restore, gateway request verified, Discord API called |
| 8 | Final invariants | All queues empty (including dead-letter), lifecycle sequence is `create → snapshot → restore`, timestamps monotonic, exactly 2 sandboxes created, 1 restore, no error logs, firewall still enforcing, channels still configured |

### Smoke Test Architecture

```
test("full-smoke: complete lifecycle", async (t) => {
  const h = createScenarioHarness();
  try {
    await t.test("Phase 1: ...", async () => { ... });
    await t.test("Phase 2: ...", async () => { ... });
    // ... phases 3-8 ...
  } catch (err) {
    await dumpDiagnostics(t, h);  // Full observability dump on failure
    throw err;
  } finally {
    h.teardown();
  }
});
```

Key design decisions:
- **Single harness** shared across all phases — state accumulates naturally
- **Subtests** (`t.test()`) give per-phase pass/fail visibility
- **`dumpDiagnostics`** on catch — timeline, queues, requests, logs all dumped on any failure
- **`globalThis.fetch` swap** — phases that need fetch set it and restore it in try/finally
- **Command responders** for firewall learning — scripted sandbox output for domain extraction

### Adding a New Smoke Test Phase

1. Add a new `await t.test("Phase N: description", async () => { ... })` inside the main test
2. The harness `h` is shared — previous phases' state is available
3. Use `h.log.info("phase-N-complete")` at the end for timeline visibility
4. Assert both the expected outcome AND that no regressions occurred (e.g., `assertNoBrowserAuthTraffic`)

---

## Mock Patterns by Subsystem

### Sandbox Lifecycle Mocking

The `FakeSandboxController` automatically handles lifecycle operations:

```typescript
// Create drives through: ensureSandboxRunning → schedule callback → execute → probe
await h.driveToRunning();

// Stop + snapshot
const snapshotId = await h.stopToSnapshot();

// Manual lifecycle with schedule capture
let scheduledCallback: (() => Promise<void> | void) | null = null;
const result = await ensureSandboxRunning({
  origin: "https://test.example.com",
  reason: "test",
  schedule(cb) { scheduledCallback = cb; },
});
await scheduledCallback!();
```

### Channel Mocking

```typescript
// Configure all channels at once
const secrets = h.configureAllChannels();

// Install default handlers (gateway + all platform APIs)
h.installDefaultGatewayHandlers("Custom reply");

// Enqueue jobs directly (bypassing webhook routes)
await enqueueChannelJob("slack", {
  payload: slackPayload,
  receivedAt: Date.now(),
  origin: "https://test.example.com",
});

// Drain specific channel
await drainSlackQueue();
await drainTelegramQueue();
await drainDiscordQueue();
```

### Firewall Mocking

```typescript
// Set mode via meta mutation (low-level)
await h.mutateMeta((m) => { m.firewall.mode = "learning"; });

// Set mode via state API (triggers sync)
await setFirewallMode("enforcing");

// Script learning log output in sandbox
const handle = h.controller.lastCreated()!;
handle.responders.push((cmd, args) => {
  if (cmd === "bash" && args?.some((a) => a.includes("shell-commands-for-learning"))) {
    return { exitCode: 0, output: async () => "curl https://api.example.com\n" };
  }
  return undefined;
});

// Ingest + approve + enforce
await ingestLearningFromSandbox(true);
await approveDomains(["api.example.com"]);
await setFirewallMode("enforcing");

// Verify network policy was applied
assert.ok(handle.networkPolicies.length >= 1);
```

### Proxy / HTML Injection Mocking

```typescript
import { injectWrapperScript } from "@/server/proxy/htmlInjection";

const injected = injectWrapperScript(rawHtml, {
  sandboxOrigin: "https://sbx-fake-1-3000.fake.vercel.run",
  gatewayToken: meta.gatewayToken,
});

// Assert injection markers
assert.ok(injected.includes("WebSocket"));
assert.ok(injected.includes("openclaw.gateway-token"));
assert.ok(injected.includes('<base href="/gateway/">'));
```

### Store Mocking

The harness automatically uses the in-memory store. For queue operations:

```typescript
const store = h.getStore();

// Check queue depths
const depth = await store.getQueueLength(channelQueueKey("slack"));

// Use assertion helpers
await assertQueuesDrained(store, "slack");
await assertQueuesDrained(store, "telegram", { deadLetter: 0 });
```

---

## Test Taxonomy

Tests in this project fall into four categories. Each serves a different purpose and uses different infrastructure.

| Category | Purpose | Harness? | Route Caller? | Example |
|----------|---------|----------|---------------|---------|
| **Unit** | Verify a single function or module in isolation | No (or minimal) | No | `domains.test.ts`, `config.test.ts`, `csrf.test.ts` |
| **Route / Contract** | Verify HTTP routes: status codes, response shapes, auth enforcement, CSRF, request validation | Yes | Yes (`callRoute` + `drainAfterCallbacks`) | `route.test.ts` files, `auth-enforcement.test.ts` |
| **Integration / Scenario** | Verify cross-subsystem flows: lifecycle + channels, drain + restore, firewall + sandbox | Yes | Sometimes | `scenarios.test.ts`, `drain-lifecycle.test.ts` |
| **Smoke** | End-to-end sequential lifecycle exercising every subsystem in a single harness | Yes | No (calls functions directly) | `full-smoke.test.ts` |
| **Failure** | Verify error paths: create failure, bootstrap timeout, API errors, retry exhaustion, dead-letter | Yes | Sometimes | Uses `FakeSandboxController` responders + `FakeFetch.otherwise()` |

### When to use which

- **Unit** when the function is pure or has minimal dependencies (domains, config generation, CSRF validation, env parsing).
- **Route / Contract** when testing the HTTP boundary: auth gates, CSRF enforcement, response status/shape, `after()` background work.
- **Integration / Scenario** when the test needs multiple subsystems wired together but does not need the full lifecycle.
- **Smoke** when verifying the complete lifecycle from `uninitialized` to `running` to `stopped` and back.
- **Failure** when verifying error handling, retry behavior, dead-letter routing, or graceful degradation.

---

## Coverage Matrix

Every source module and its corresponding test file(s). Status indicates coverage depth.

### API Routes

| Source Module | Test File(s) | Status | Notes |
|--------------|-------------|--------|-------|
| `src/app/api/health/route.ts` | `src/app/api/health/route.test.ts` | Tested | Unauthenticated 200 |
| `src/app/api/status/route.ts` | `src/app/api/status/route.test.ts` | Tested | GET/POST, CSRF, heartbeat touch |
| `src/app/api/admin/ensure/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Auth + lifecycle trigger |
| `src/app/api/admin/stop/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Auth + stop flow |
| `src/app/api/admin/snapshot/route.ts` | `src/app/api/admin/snapshot/route.test.ts` | Tested | Snapshot-and-stop |
| `src/app/api/admin/snapshots/route.ts` | `src/app/api/admin/snapshots/route.test.ts` | Tested | List snapshots |
| `src/app/api/admin/snapshots/restore/route.ts` | `src/app/api/admin/admin-lifecycle.test.ts` | Tested | Restore from snapshot |
| `src/app/api/admin/ssh/route.ts` | `src/app/api/admin/ssh/route.test.ts` | Tested | SSH session |
| `src/app/api/admin/logs/route.ts` | `src/app/api/admin/logs/route.test.ts` | Tested | Log streaming |
| `src/app/api/auth/authorize/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | OAuth redirect |
| `src/app/api/auth/callback/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | Token exchange |
| `src/app/api/auth/signout/route.ts` | `src/app/api/auth/auth-routes.test.ts` | Tested | Session clear |
| `src/app/api/firewall/route.ts` | `src/app/api/firewall/route.test.ts` | Tested | GET/PUT firewall status |
| `src/app/api/firewall/test/route.ts` | `src/app/api/firewall/test/route.test.ts` | Tested | Firewall test endpoint |
| `src/app/api/firewall/allowlist/route.ts` | `src/app/api/admin-firewall-routes.test.ts` | Tested | Allowlist CRUD |
| `src/app/api/firewall/promote/route.ts` | `src/app/api/admin-firewall-routes.test.ts` | Tested | Promote to enforcing |
| `src/app/api/channels/summary/route.ts` | `src/app/api/channels/summary/route.test.ts` | Tested | Queue counts, config |
| `src/app/api/channels/slack/webhook/route.ts` | `src/server/channels/slack/route.test.ts` | Tested | Signature validation |
| `src/app/api/channels/slack/route.ts` | `src/server/channels/slack/route.test.ts` | Tested | Slack config admin |
| `src/app/api/channels/slack/manifest/route.ts` | `src/app/api/channels/slack/manifest/route.test.ts` | Tested | Slack manifest generation |
| `src/app/api/channels/slack/test/route.ts` | `src/app/api/channels/slack/test/route.test.ts` | Tested | Slack test endpoint |
| `src/app/api/channels/telegram/webhook/route.ts` | `src/server/channels/telegram/route.test.ts` | Tested | Secret validation |
| `src/app/api/channels/telegram/route.ts` | `src/server/channels/telegram/route.test.ts` | Tested | Telegram config admin |
| `src/app/api/channels/telegram/preview/route.ts` | `src/app/api/channels/telegram/preview/route.test.ts` | Tested | Telegram preview |
| `src/app/api/channels/discord/webhook/route.ts` | `src/server/channels/discord/route.test.ts` | Tested | Ed25519 + PING |
| `src/app/api/channels/discord/route.ts` | `src/server/channels/discord/route.test.ts` | Tested | Discord config admin |
| `src/app/api/channels/discord/register-command/route.ts` | `src/app/api/channels/discord/register-command/route.test.ts` | Tested | `/ask` registration |
| `src/app/api/cron/drain-channels/route.ts` | `src/app/api/cron/drain-channels/route.test.ts` | Tested | CRON_SECRET, drain all |
| `src/app/gateway/[[...path]]/route.ts` | `src/app/gateway/route.test.ts` | Tested | Auth, waiting page, injection, WS rewrite |

### Server Modules

| Source Module | Test File(s) | Status | Notes |
|--------------|-------------|--------|-------|
| **Auth** | | | |
| `src/server/auth/csrf.ts` | `src/server/auth/csrf.test.ts` | Tested | Origin + header validation |
| `src/server/auth/session.ts` | `src/server/auth/session.test.ts` | Tested | Cookie encrypt/decrypt |
| `src/server/auth/vercel-auth.ts` | `src/server/auth/vercel-auth.test.ts` | Tested | JWKS, token exchange, refresh |
| `src/server/auth/route-auth.ts` | `src/app/api/auth/auth-enforcement.test.ts` | Tested | Auth middleware for routes |
| **Channels** | | | |
| `src/server/channels/driver.ts` | `src/server/channels/driver.test.ts` | Tested | Dedup, drain lock, malformed jobs, retry |
| `src/server/channels/state.ts` | `src/server/channels/state.test.ts` | Tested | Channel state management |
| `src/server/channels/history.ts` | `src/server/channels/history.test.ts` | Tested | Conversation history |
| `src/server/channels/keys.ts` | `src/server/channels/keys.test.ts` | Tested | Queue key helpers |
| `src/server/channels/core/reply.ts` | `src/server/channels/core/reply.test.ts` | Tested | Reply formatting core |
| `src/server/channels/core/types.ts` | — | N/A | Type definitions only |
| `src/server/channels/slack/adapter.ts` | `src/server/channels/slack/adapter.test.ts` | Tested | Thread replies, formatting |
| `src/server/channels/slack/runtime.ts` | `src/server/channels/slack/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| `src/server/channels/telegram/adapter.ts` | `src/server/channels/telegram/adapter.test.ts` | Tested | Message routing |
| `src/server/channels/telegram/bot-api.ts` | `src/server/channels/telegram/bot-api.test.ts` | Tested | Bot API helpers |
| `src/server/channels/telegram/runtime.ts` | `src/server/channels/telegram/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| `src/server/channels/discord/adapter.ts` | `src/server/channels/discord/adapter.test.ts` | Tested | Deferred responses |
| `src/server/channels/discord/application.ts` | `src/server/channels/discord/application.test.ts` | Tested | Discord application setup |
| `src/server/channels/discord/discord-api.ts` | `src/server/channels/discord/discord-api.test.ts` | Tested | API helpers |
| `src/server/channels/discord/runtime.ts` | `src/server/channels/discord/runtime.test.ts`, `drain.test.ts` | Tested | Runtime behavior + drain |
| **Firewall** | | | |
| `src/server/firewall/domains.ts` | `src/server/firewall/domains.test.ts` | Tested | Extraction, normalization, dedup |
| `src/server/firewall/policy.ts` | `src/server/firewall/state.test.ts` | Tested | Mode mapping contract |
| `src/server/firewall/state.ts` | `src/server/firewall/state.test.ts`, `firewall-sync.test.ts` | Tested | Mode transitions, learning |
| **Sandbox & Lifecycle** | | | |
| `src/server/sandbox/lifecycle.ts` | `src/server/sandbox/lifecycle.test.ts`, `scenarios.test.ts`, `route-scenarios.test.ts` | Tested | State machine, transitions |
| `src/server/sandbox/controller.ts` | — | N/A | Production wrapper for `@vercel/sandbox` (mocked by `FakeSandboxController`) |
| **OpenClaw** | | | |
| `src/server/openclaw/bootstrap.ts` | `src/server/openclaw/bootstrap.test.ts` | Tested | Install, config write, gateway health |
| `src/server/openclaw/config.ts` | `src/server/openclaw/config.test.ts` | Tested | Config generation |
| **Proxy** | | | |
| `src/server/proxy/htmlInjection.ts` | `src/server/proxy/htmlInjection.test.ts` | Tested | Script injection, WS rewrite |
| `src/server/proxy/proxy-route-utils.ts` | `src/server/proxy/proxy-route-utils.test.ts` | Tested | Path traversal, sanitization |
| `src/server/proxy/waitingPage.ts` | `src/server/proxy/waitingPage.test.ts` | Tested | Waiting page HTML |
| **Store** | | | |
| `src/server/store/store.ts` | `src/server/store/store.test.ts` | Tested | Backend selection, metadata shape |
| `src/server/store/memory-store.ts` | `src/server/store/store.test.ts` | Tested | Used by all test harnesses |
| `src/server/store/redis-store.ts` | — | Untested | Production-only; same interface as memory |
| **Other** | | | |
| `src/server/env.ts` | `src/server/env.test.ts` | Tested | Env variable validation |
| `src/server/log.ts` | `src/server/log.test.ts` | Tested | Structured logger contract |

### Cross-cutting / Integration

| Test File | Category | Covers |
|-----------|----------|--------|
| `src/server/smoke/full-smoke.test.ts` | Smoke | Full 8-phase lifecycle: create, proxy, firewall, stop, restore, channels, invariants |
| `src/server/sandbox/scenarios.test.ts` | Integration | Lifecycle + channels end-to-end |
| `src/server/sandbox/route-scenarios.test.ts` | Integration | Route-level lifecycle flows |
| `src/server/channels/drain.test.ts` | Integration | Queue draining across all platforms |
| `src/server/channels/drain-retry.test.ts` | Failure | Retry behavior for failed drains |
| `src/server/channels/drain-lifecycle.test.ts` | Integration | Drain triggers sandbox restore |
| `src/server/channels/drain-auth-decay.test.ts` | Failure | Auth token expiry during drain |
| `src/test-utils/harness-isolation.test.ts` | Unit | Harness teardown correctness |

### Coverage Gaps (untested source modules)

All source modules now have direct test coverage. The only remaining indirectly-tested files are:

| Module | Risk | Status |
|--------|------|--------|
| `src/server/store/redis-store.ts` | Low | Same interface as memory-store; integration-tested via `store.test.ts`. Network behavior requires a live Redis. |

Previously listed gaps that are now covered:

- `src/app/api/channels/slack/route.ts` → `slack/route.test.ts` ✅
- `src/app/api/channels/slack/manifest/route.ts` → `channels/slack/manifest/route.test.ts` ✅
- `src/app/api/channels/slack/test/route.ts` → `channels/slack/test/route.test.ts` ✅
- `src/app/api/channels/telegram/route.ts` → `telegram/route.test.ts` ✅
- `src/app/api/channels/telegram/preview/route.ts` → `channels/telegram/preview/route.test.ts` ✅
- `src/app/api/channels/discord/route.ts` → `discord/route.test.ts` ✅
- `src/app/api/channels/discord/register-command/route.ts` → `channels/discord/register-command/route.test.ts` ✅
- `src/server/channels/discord/application.ts` → `discord/application.test.ts` ✅
- `src/server/channels/keys.ts` → `keys.test.ts` ✅
- `src/server/channels/core/reply.ts` → `core/reply.test.ts` ✅
- `src/server/log.ts` → `log.test.ts` ✅

---

## Failure Matrix

Error-path scenarios that must be tested to claim complete verification. Each entry describes the failure, how to simulate it, and what the system should do.

### Lifecycle Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Sandbox create fails | `h.controller` throws on `create()` | Status stays/returns to `error`; no sandbox leak |
| Bootstrap command fails | Responder returns `{ exitCode: 1 }` for install command | Status → `error`; sandbox cleaned up |
| Gateway probe timeout | `ff.onGet(/fake\.vercel\.run/)` returns 503 or never resolves | Status stays `booting`; retry on next access |
| Snapshot fails | `handle.snapshot()` throws | Status → `error`; sandbox still accessible until next attempt |
| Restore fails (bad snapshot) | `h.controller` throws on restore with snapshot ID | Status → `error`; does not corrupt metadata |
| Concurrent `ensureSandboxRunning` | Call twice before first completes | Only one create/restore; second call returns waiting state |
| `after()` callback throws | Schedule callback that throws | Error logged; does not crash route response |

### Channel / Drain Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Gateway completions API error | `ff.onPost(/completions/)` returns 500 | Job retried; eventually dead-lettered |
| Slack API post failure | `ff.onPost(/slack\.com/)` returns `{ ok: false }` | Reply failure logged; job still completes (message was processed) |
| Telegram API failure | `ff.onPost(/telegram\.org/)` returns 400 | Reply failure logged; job completes |
| Discord follow-up failure | `ff.onPost(/discord\.com/)` returns 500 | Retry or dead-letter |
| Malformed queue job | Enqueue a job with missing `payload` field | Job skipped with error log; queue not blocked |
| Queue processing crash | `ff.otherwise(() => { throw new Error("boom"); })` | Processing lock released; job retried |
| Dead-letter overflow | Exhaust retry count | Job moved to dead-letter queue; processing continues |

### Auth Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Expired session cookie | `buildSessionCookie({ expiresAt: Date.now() - 1000 })` | 401/redirect to login |
| Invalid session cookie | Garbage cookie value | 401/redirect; no crash |
| Token refresh failure | `ff.onPost(/token/)` returns 401 | Session cleared; user redirected to login |
| Missing CSRF headers | `buildGetRequest` without auth headers on mutating route | 403 |
| Wrong origin in CSRF | Request with `origin: https://evil.com` | 403 |
| No auth on protected route | Plain GET to `/api/admin/ensure` | 401/403 |
| Auth before gateway token | Unauthenticated GET to `/gateway` | Redirect to login; token never exposed |

### Firewall Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Learning log empty | Responder returns empty string for log file | No domains ingested; no crash |
| Learning log malformed | Responder returns garbage text | Parseable domains extracted; rest ignored |
| Sync without running sandbox | Call `syncFirewall()` when status is `stopped` | No-op; no crash |
| Policy update fails | Handle throws on `updateNetworkPolicy()` | Error logged; firewall state not corrupted |

### Bootstrap Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| `openclaw` install fails | Responder returns `exitCode: 1` for npm install | Status → `error`; clear error message |
| Config write fails | Handle `writeFiles()` throws | Status → `error` |
| Gateway never becomes healthy | Probe always returns 503 | Status stays `booting`; does not loop forever |
| AI Gateway key missing | Env without `AI_GATEWAY_API_KEY` | Bootstrap skips key file; still functional |

### Store Failures

| Scenario | Simulation | Expected Behavior |
|----------|-----------|-------------------|
| Store read returns `null` | Fresh store with no metadata | `ensureMetaShape` creates default metadata |
| Metadata shape outdated | Store contains old-shape metadata | `ensureMetaShape` migrates fields |
| Concurrent metadata mutation | Two `mutateMeta` calls in parallel | Last write wins; no corruption |

### Failure Test Pattern

```typescript
test("[lifecycle] create failure → status becomes error", async () => {
  const h = createScenarioHarness();
  try {
    // Make the controller throw on create
    const origCreate = h.controller.create.bind(h.controller);
    h.controller.create = async () => { throw new Error("API unavailable"); };

    let scheduled: (() => Promise<void>) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) { scheduled = cb; },
    });
    await scheduled!();

    const meta = await h.getMeta();
    assert.equal(meta.status, "error");
  } finally {
    h.teardown();
  }
});

test("[channels] gateway API 500 → job retried then dead-lettered", async () => {
  const h = createScenarioHarness();
  try {
    // All completions calls fail
    h.fakeFetch.onPost(/v1\/chat\/completions/, () =>
      new Response("Internal Server Error", { status: 500 })
    );
    h.fakeFetch.onPost(/slack\.com/, () => slackOkResponse());

    await h.mutateMeta((m) => { m.status = "running"; m.sandboxId = "sbx-1"; });
    h.configureAllChannels();

    await enqueueChannelJob("slack", {
      payload: slackPayload,
      receivedAt: Date.now(),
      origin: "https://test.example.com",
    });

    // Drain multiple times to exhaust retries
    for (let i = 0; i < 5; i++) await drainSlackQueue();

    const store = h.getStore();
    await assertQueuesDrained(store, "slack", { queue: 0, processing: 0, deadLetter: 1 });
  } finally {
    h.teardown();
  }
});

test("[auth] expired cookie → 401 on protected route", async () => {
  const h = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  try {
    const setCookie = await buildSessionCookie({
      expiresAt: Date.now() - 60_000, // expired 1 minute ago
    });
    const cookie = setCookieToCookieHeader(setCookie);
    const route = getStatusRoute();
    const result = await callRoute(route.GET!, buildGetRequest("/api/status", { cookie }));
    assert.ok(result.status === 401 || result.status === 302);
  } finally {
    h.teardown();
  }
});
```

---

## Run Matrix

Tests can be run under different auth modes and store backends to verify behavior across configurations.

### Auth Mode Variations

| Auth Mode | Env Setup | What It Tests |
|-----------|-----------|---------------|
| `deployment-protection` (default) | `VERCEL_AUTH_MODE=deployment-protection` or unset | Vercel's built-in protection; bypass header `x-vercel-protection-bypass` |
| `sign-in-with-vercel` | `createScenarioHarness({ authMode: 'sign-in-with-vercel' })` | Cookie sessions, JWKS validation, refresh flow |
| `none` | `createScenarioHarness({ authMode: 'none' })` | No auth enforced; useful for channel webhook tests |

### Store Backend Variations

| Backend | Env Setup | When to Use |
|---------|-----------|-------------|
| Memory (default in tests) | No `REDIS_URL` set | All unit/route/integration tests |
| Redis | `REDIS_URL` set | Manual smoke testing against real store |

### Running Tests

```bash
# All tests (memory store, deployment-protection auth)
pnpm test

# All gates via verifier
node scripts/verify.mjs

# Single step via verifier
node scripts/verify.mjs --steps=test
node scripts/verify.mjs --steps=lint
node scripts/verify.mjs --steps=typecheck
node scripts/verify.mjs --steps=build
```

### Per-Auth-Mode Test Strategy

Every route that enforces auth should have tests for:

1. **Happy path with valid credentials** — 200 response
2. **No credentials** — 401 or 302 redirect
3. **Invalid/expired credentials** — 401 or 302
4. **Wrong auth mode credentials** — e.g., cookie sent when `deployment-protection` is active

```typescript
// Template: auth-mode test matrix for a route
for (const mode of ["deployment-protection", "sign-in-with-vercel"] as const) {
  test(`[${mode}] GET /api/status without auth → rejected`, async () => {
    const h = createScenarioHarness({ authMode: mode });
    try {
      const route = getStatusRoute();
      const result = await callRoute(route.GET!, buildGetRequest("/api/status"));
      assert.ok(result.status === 401 || result.status === 302);
    } finally {
      h.teardown();
    }
  });
}
```

---

## Patterns for Adding New Tests

### New Route Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  callRoute,
  drainAfterCallbacks,
  buildAuthPostRequest,
} from "@/test-utils/route-caller";

patchNextServerAfter();

test("POST /api/my-route returns 200", async () => {
  const h = createScenarioHarness();
  try {
    // Lazy-load route after harness sets up mocks
    const { POST } = await import("@/app/api/my-route/route");

    const request = buildAuthPostRequest("/api/my-route", JSON.stringify({ key: "value" }));
    const result = await callRoute(POST!, request);
    assert.equal(result.status, 200);

    // Run background work (lifecycle, queue, etc.)
    await drainAfterCallbacks();
  } finally {
    h.teardown();
  }
});
```

### New Unit Test (Colocated)

```typescript
// src/server/feature/my-module.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { myFunction } from "@/server/feature/my-module";

test("myFunction handles normal input", () => {
  assert.equal(myFunction("input"), "expected");
});

test("myFunction rejects bad input", () => {
  assert.throws(() => myFunction(""), { message: /required/ });
});
```

### New Channel Adapter Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import {
  patchNextServerAfter,
  callRoute,
  drainAfterCallbacks,
  getSlackWebhookRoute,
} from "@/test-utils/route-caller";
import { buildSlackWebhook } from "@/test-utils/webhook-builders";
import { gatewayReadyResponse, chatCompletionsResponse, slackOkResponse } from "@/test-utils/fake-fetch";

patchNextServerAfter();

test("Slack webhook enqueues and drains", async () => {
  const h = createScenarioHarness();
  try {
    h.fakeFetch.onGet(/fake\.vercel\.run/, () => gatewayReadyResponse());
    h.fakeFetch.onPost(/v1\/chat\/completions/, () => chatCompletionsResponse("Hi!"));
    h.fakeFetch.onPost(/slack\.com\/api/, () => slackOkResponse());

    await h.mutateMeta((m) => { m.status = "running"; m.sandboxId = "sbx-123"; });

    const secrets = h.configureAllChannels();
    const route = getSlackWebhookRoute();
    const webhook = buildSlackWebhook({
      signingSecret: secrets.slackSigningSecret,
      payload: {
        event: { type: "app_mention", text: "hello", channel: "C1", ts: "1.1" },
      },
    });

    const result = await callRoute(route.POST!, webhook);
    assert.equal(result.status, 200);

    await drainAfterCallbacks();
  } finally {
    h.teardown();
  }
});
```

### New Failure Path Test

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioHarness } from "@/test-utils/harness";
import { dumpDiagnostics } from "@/test-utils/harness";

test("[lifecycle] bootstrap install failure → error status", async (t) => {
  const h = createScenarioHarness();
  try {
    // Script the sandbox to fail on npm install
    h.controller.onNextCreate((handle) => {
      handle.responders.push((cmd, args) => {
        if (cmd === "bash" && args?.some((a) => a.includes("npm install"))) {
          return { exitCode: 1, output: async () => "ERR! 404 Not Found" };
        }
        return undefined;
      });
    });

    let scheduled: (() => Promise<void>) | null = null;
    await ensureSandboxRunning({
      origin: "https://test.example.com",
      reason: "test",
      schedule(cb) { scheduled = cb; },
    });
    await scheduled!();

    const meta = await h.getMeta();
    assert.equal(meta.status, "error");
    assert.ok(meta.lastError?.includes("install"));
  } catch (err) {
    await dumpDiagnostics(t, h);
    throw err;
  } finally {
    h.teardown();
  }
});
```

### Auth Mode Variation Test

```typescript
import { createScenarioHarness } from "@/test-utils/harness";
import {
  buildSessionCookie,
  setCookieToCookieHeader,
  buildDeploymentProtectionHeaders,
} from "@/test-utils/auth-fixtures";

test("route works with sign-in-with-vercel", async () => {
  const h = createScenarioHarness({ authMode: "sign-in-with-vercel" });
  try {
    const setCookie = await buildSessionCookie();
    const cookie = setCookieToCookieHeader(setCookie);
    const request = buildAuthGetRequest("/api/status", { cookie });
    const result = await callRoute(route.GET!, request);
    assert.equal(result.status, 200);
  } finally {
    h.teardown();
  }
});

test("route works with deployment-protection", async () => {
  const h = createScenarioHarness({ authMode: "deployment-protection" });
  try {
    const headers = buildDeploymentProtectionHeaders();
    const request = buildGetRequest("/api/status", headers);
    const result = await callRoute(route.GET!, request);
    assert.equal(result.status, 200);
  } finally {
    h.teardown();
  }
});
```

### New Smoke Test Scenario

To add a new scenario to the full smoke test:

```typescript
// In src/server/smoke/full-smoke.test.ts, inside the main test:

await t.test("Phase N: my new scenario", async () => {
  // Previous phases' state is available via h
  const meta = await h.getMeta();

  // Set up mocks specific to this scenario
  h.fakeFetch.onPost(/my-pattern/, () => Response.json({ ok: true }));

  // Exercise the subsystem
  const result = await myFunction();

  // Assert outcomes
  assert.equal(result.status, "expected");

  // Assert no regressions
  assertNoBrowserAuthTraffic(h.fakeFetch.requests());

  h.log.info("phase-N-complete");
});
```

---

## Definition of Done

A test suite achieves "complete verification" when all four categories are satisfied. Use this checklist when adding tests or auditing coverage.

### Happy-Path Coverage

- [ ] Every API route has at least one test that exercises the success path with valid auth
- [ ] Every server module with logic (not just types/constants) has a corresponding test file
- [ ] Full smoke test passes all phases without modifications
- [ ] All channel platforms (Slack, Telegram, Discord) have webhook → enqueue → drain → reply tests
- [ ] Lifecycle state machine covers all valid transitions: `uninitialized → creating → setup → booting → running → stopped → restoring → running`
- [ ] Firewall covers all modes: `disabled`, `learning`, `enforcing`
- [ ] Proxy HTML injection verified: script tag, WS rewrite, base tag, token in script only

### Error-Path Coverage

- [ ] Lifecycle failures tested: create fail, bootstrap fail, probe timeout, snapshot fail, restore fail
- [ ] Channel failures tested: gateway API error, platform API error, malformed job, retry exhaustion, dead-letter
- [ ] Auth failures tested: expired cookie, invalid cookie, missing credentials, refresh failure
- [ ] Firewall failures tested: empty/malformed learning log, sync without sandbox, policy update failure
- [ ] Bootstrap failures tested: install fail, config write fail, gateway never healthy
- [ ] Store failures tested: null metadata, outdated shape migration, concurrent mutation

### Auth Boundary Coverage

- [ ] Every protected route rejects unauthenticated requests (401/302)
- [ ] Every protected route accepts valid `deployment-protection` credentials
- [ ] Every protected route accepts valid `sign-in-with-vercel` session cookies
- [ ] Gateway route never exposes gateway token without auth
- [ ] CSRF validation tested: missing headers → 403, wrong origin → 403
- [ ] Auth refresh failure clears session and forces re-login

### Regression Guards

- [ ] No `export const runtime` in any route handler
- [ ] `patchNextServerAfter()` called before route imports in all route tests
- [ ] `drainAfterCallbacks()` called after every route invocation
- [ ] `try/finally` teardown in every test using a harness
- [ ] `dumpDiagnostics(t, h)` in catch blocks for integration/scenario tests
- [ ] Smoke test invariants verified: queue drain, lifecycle sequence, timestamp monotonicity, error log absence

### Gate Commands

All four gates must pass before work is considered complete:

```bash
pnpm lint        # Gate 1: formatting + imports
pnpm test        # Gate 2: all tests pass
pnpm typecheck   # Gate 3: no type errors
pnpm build       # Gate 4: production build succeeds
```

---

## Testing Principles

1. **Isolation** — Each test gets a fresh harness with reset singletons, env, and store
2. **No real network** — All HTTP intercepted via `FakeFetch`; no actual API calls
3. **No sandbox API** — `FakeSandboxController` mocks `@vercel/sandbox` entirely
4. **Deterministic** — Fake delays, ordered event logs, predictable responses
5. **Async aware** — `after()` callbacks captured and drained explicitly
6. **Auth configurable** — Tests can run in any auth mode
7. **Always teardown** — Use `try/finally` with `h.teardown()` or `withHarness`
8. **Observability on failure** — Use `dumpDiagnostics(t, h)` in catch blocks
9. **Test naming** — Use `[area] precondition → action → expected` pattern
10. **Smoke test accumulates** — Single harness across phases; state builds naturally
11. **Failure paths are first-class** — Error scenarios deserve dedicated tests, not just happy-path assertions
12. **Auth boundaries are security boundaries** — Every protected route must be tested without credentials

---

## Complete Verification Protocol

Before marking any work complete, pass ALL gates in order:

```bash
# Gate 1: Lint — catches formatting and import issues
pnpm lint

# Gate 2: Tests — all tests pass (including smoke)
pnpm test

# Gate 3: Type check — no type errors
pnpm typecheck

# Gate 4: Build — production build succeeds
pnpm build
```

### Verification Checklist

- [ ] All existing tests still pass (no regressions)
- [ ] Smoke test passes all 8 phases
- [ ] No `export const runtime` added to route handlers
- [ ] `try/finally` teardown in all new tests
- [ ] `patchNextServerAfter()` called before route imports
- [ ] `drainAfterCallbacks()` called after route invocations
- [ ] New env vars documented in `.env.example` and `CLAUDE.md`
- [ ] Metadata shape changes reflected in `ensureMetaShape`
- [ ] Definition of Done checklist satisfied for the category of work

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@vercel/sandbox` | Sandbox VM lifecycle (create, stop, snapshot, restore) |
| `ioredis` | Persistent state store (Redis wire protocol) |
| `@vercel/oidc` | Vercel OAuth token exchange |
| `jose` | JWT signing/verification for session cookies |
| `next` 16 | App Router framework |

## Test Utilities File Index

| File | Lines | Purpose |
|------|-------|---------|
| `src/test-utils/harness.ts` | 565 | Central scaffold: controller, fetch, store, log, scenario helpers, observability |
| `src/test-utils/fake-fetch.ts` | 225 | HTTP interception + preset responses |
| `src/test-utils/fake-sandbox-controller.ts` | 222 | Complete `@vercel/sandbox` mock |
| `src/test-utils/route-caller.ts` | 486 | Route invocation + patching + request builders + lazy loaders |
| `src/test-utils/webhook-builders.ts` | 213 | Signed webhook requests (Slack, Telegram, Discord) |
| `src/test-utils/auth-fixtures.ts` | 117 | Session cookies + deployment protection headers |
| `src/test-utils/assertions.ts` | 175 | Reusable assertion helpers (gateway, queues, history, auth) |

## Critical Gotchas

- **`patchNextServerAfter()`** must be called at module top level, before any route imports
- **`drainAfterCallbacks()`** is required after route calls to execute `after()` background work
- **Teardown is mandatory** — leaking harness state corrupts subsequent tests
- **Lazy route loading** — always use `getXxxRoute()` helpers or dynamic `import()` after harness setup
- **`snapshot()` is DESTRUCTIVE** — calling snapshot stops the sandbox; never use as diagnostic
- **Store defaults to memory** — without `REDIS_URL`, data is lost on redeploy
- **No `export const runtime`** — explicit runtime exports break the Next.js 16 build with `cacheComponents: true`
- **`globalThis.fetch` swap** — the harness installs fakeFetch as `globalThis.fetch` for its full lifetime with default-deny on unmatched requests, restored in teardown
- **Command responders** — return `undefined` to fall through to default behavior; first non-undefined wins
- **Smoke test is sequential** — phases depend on each other; don't reorder without understanding the state flow
- **`pnpm test` is the canonical runner** — never use `bun test` (different resolver, different globals, will produce false failures)

### Test Isolation Guards (`NODE_ENV=test`)

The following subsystems fail closed in test mode to prevent accidental production side effects:

| Subsystem | Guard behavior | What would go wrong without it |
|-----------|---------------|-------------------------------|
| **Sandbox controller** | `getSandboxController()` throws unless `_setSandboxControllerForTesting()` was called. `_setSandboxControllerForTesting()` throws if `NODE_ENV !== "test"`. In production, always returns the real SDK wrapper — no mutable singleton. | Tests would create real Vercel Sandbox VMs; production would use fake controllers if singleton leaked |
| **Redis store** | Redis only connects on deployed Vercel runtimes (`isVercelDeployment()`). Tests and local dev always use memory store, even if `REDIS_URL` is present. | Fake sandbox IDs (`sbx-fake-*`) would corrupt production metadata |
| **Workflow DevKit** | Channel webhooks call `start(drainChannelWorkflow)` from `workflow/api`. In tests, `start()` is not available (no workflow runtime), so webhook routes catch the error and return 200 gracefully. | Tests would start real workflow runs on Vercel's infrastructure |
| **OIDC token** | `resolveAiGatewayCredentialOptional()` skips real OIDC fetch, falls back to API key or undefined | Tests would call Vercel's OIDC provider |
| **Vercel markers** | Harness clears `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL` | `isVercelDeployment()` would return true, triggering Vercel-only code paths |

The harness sets these env overrides automatically. If you're writing a test that doesn't use the harness, set `NODE_ENV=test` explicitly and clear Vercel env vars.

---

## Smoke Test Tiers

Testing is organized into three smoke tiers, each building on the previous:

### Tier 1: Happy-Path Smoke (`full-smoke.test.ts`)

The existing 8-phase end-to-end lifecycle test. Exercises:
- Fresh create + bootstrap → running
- Proxy HTML injection + WebSocket rewrite + no token leak
- Firewall learning → enforce → policy applied
- Snapshot stop → restore via channel trigger
- Multi-channel replies (Slack, Telegram, Discord)
- Final invariants (clean queues, correct lifecycle sequence)

**When to run:** After any change to lifecycle, proxy, firewall, or channel modules.

### Tier 2: Failure & Concurrency Smoke (`concurrency-smoke.test.ts`)

Tests edge cases the happy path misses:
- Simultaneous restore attempts (only one sandbox created)
- Stop during active drain (clean shutdown, no orphan processing items)
- Double-snapshot (idempotent)
- Crash recovery (expired leases requeued, drain lock released)
- Auth session expiry during active proxy session

**When to run:** After changes to state transitions, queue processing, or lock management.

### Tier 3: Route-Level Smoke (`route-smoke.test.ts`)

Tests the actual Next.js route handlers end-to-end through the route-caller utilities:
- Admin routes: ensure, stop, snapshot, ssh, logs, snapshots-list, restore
- Firewall routes: GET/PUT/POST/DELETE with test and allowlist management
- Channel webhooks: Slack, Telegram, Discord (signature verification)
- Auth routes: authorize, callback, signout
- Gateway proxy: auth gating, waiting page, HTML injection
- Status/health: GET/POST status, GET health
- Cron: drain-channels with CRON_SECRET
- Auth enforcement: 401/403 for unauthenticated requests
- CSRF checks: missing origin/x-requested-with on mutations

**When to run:** After changes to any route handler or auth middleware.

---

## fakeFetch Request-Object Fix

The `fakeFetch` utility in `src/test-utils/fake-fetch.ts` handles both calling conventions:

1. `fetch(url: string, init?: RequestInit)` — the simple form
2. `fetch(request: Request, init?: RequestInit)` — the Request-object form

**When it matters:** Route handlers and auth code that construct `new Request(url, { method, headers, body })` and pass the whole object to `fetch()`. Without this fix, the fake would fail to extract method, headers, and body from Request objects, causing false-green tests where the request content is silently lost.

The fix checks `typeof input !== "string"` and reads `.method`, `.headers`, `.body` from the Request object when `init` doesn't provide them. The `init` parameter always takes precedence (merge behavior).

Tests for this live in `src/test-utils/harness-isolation.test.ts` under the `fakeFetch:` prefix.

---

## Coverage Manifest

Every source file mapped to its test file(s). Files marked with ✅ have direct unit tests. Files marked with 🔥 are covered indirectly through smoke or integration tests.

### `src/server/sandbox/`
| Source | Test | Coverage |
|--------|------|----------|
| `controller.ts` | `controller.test.ts` | ✅ Interface shape, swap mechanism, event logging |
| `lifecycle.ts` | `lifecycle.test.ts` | ✅ State transitions, ensure/stop/snapshot/touch |
| `lifecycle.ts` | `route-scenarios.test.ts`, `scenarios.test.ts` | 🔥 Multi-step scenario flows |

### `src/server/firewall/`
| Source | Test | Coverage |
|--------|------|----------|
| `policy.ts` | `policy.test.ts` | ✅ toNetworkPolicy all modes, applyFirewallPolicyToSandbox |
| `state.ts` | `state.test.ts` | ✅ Mode transitions, learning ingestion, domain extraction |
| `domains.ts` | `domains.test.ts` | ✅ Domain parsing and normalization |
| `state.ts` | `firewall-sync.test.ts` | ✅ Sync mutations after state changes |

### `src/server/channels/`
| Source | Test | Coverage |
|--------|------|----------|
| `driver.ts` | `driver.test.ts` | ✅ Enqueue, drain, retry, dedup, dead letter |
| `keys.ts` | `keys.test.ts` | ✅ All key generators, uniqueness |
| `state.ts` | `state.test.ts` | ✅ Channel config CRUD |
| `core/reply.ts` | `core/reply.test.ts` | ✅ extractReply, toPlainText, image extraction |
| `history.ts` | `history.test.ts` | ✅ Session history persistence |
| `slack/adapter.ts` | `slack/adapter.test.ts` | ✅ Message extraction, reply formatting |
| `slack/route.ts` | `slack/route.test.ts` | ✅ Webhook validation, enqueue |
| `telegram/adapter.ts` | `telegram/adapter.test.ts` | ✅ Message extraction, reply |
| `telegram/bot-api.ts` | `telegram/bot-api.test.ts` | ✅ Bot API calls |
| `telegram/route.ts` | `telegram/route.test.ts` | ✅ Webhook secret validation |
| `discord/adapter.ts` | `discord/adapter.test.ts` | ✅ Interaction handling |
| `discord/discord-api.ts` | `discord/discord-api.test.ts` | ✅ Discord REST calls |
| `discord/route.ts` | `discord/route.test.ts` | ✅ Ed25519 signature verification |
| `discord/application.ts` | `discord/application.test.ts` | ✅ Application setup, command registration |
| `slack/runtime.ts` | `slack/runtime.test.ts` | ✅ Slack runtime behavior |
| `telegram/runtime.ts` | `telegram/runtime.test.ts` | ✅ Telegram runtime behavior |
| `discord/runtime.ts` | `discord/runtime.test.ts` | ✅ Discord runtime behavior |
| `drain.ts` (shared drain) | `drain.test.ts` | ✅ Generic drain logic |
| `drain.ts` | `drain-lifecycle.test.ts` | ✅ Drain triggers sandbox restore |
| `drain.ts` | `drain-retry.test.ts` | ✅ Retry backoff and dead letter |
| `drain.ts` | `drain-auth-decay.test.ts` | ✅ Auth decay during drain |

### `src/server/auth/`
| Source | Test | Coverage |
|--------|------|----------|
| `vercel-auth.ts` | `vercel-auth.test.ts` | ✅ OAuth flow, token exchange, session building |
| `vercel-auth.ts` | `route-auth.test.ts` | ✅ requireRouteAuth both modes, sanitizeNextPath |
| `session.ts` | `session.test.ts` | ✅ Cookie encryption/decryption, serialization |
| `csrf.ts` | `csrf.test.ts` | ✅ CSRF token validation |

### `src/server/store/`
| Source | Test | Coverage |
|--------|------|----------|
| `store.ts` | `store.test.ts` | ✅ Store selection, singleton, mutateMeta CAS |
| `memory-store.ts` | `memory-store.test.ts` | ✅ Full contract: meta, KV, queues, leases, locks |
| `redis-store.ts` | — | 🔥 Same interface as memory-store; integration-tested via store.test.ts |

### `src/server/proxy/`
| Source | Test | Coverage |
|--------|------|----------|
| `htmlInjection.ts` | `htmlInjection.test.ts` | ✅ Script injection, WS rewrite |
| `waitingPage.ts` | `waitingPage.test.ts` | ✅ Waiting page HTML generation |
| `proxy-route-utils.ts` | `proxy-route-utils.test.ts` | ✅ Proxy request building |

### `src/server/openclaw/`
| Source | Test | Coverage |
|--------|------|----------|
| `bootstrap.ts` | `bootstrap.test.ts` | ✅ Install, config write, gateway wait |
| `config.ts` | `config.test.ts` | ✅ Config generation |

### `src/server/`
| Source | Test | Coverage |
|--------|------|----------|
| `env.ts` | `env.test.ts` | ✅ Env getters, auth mode selection |
| `log.ts` | `log.test.ts` | ✅ Structured logger contract, id/source fields |

### `src/app/api/` (Route Handlers)
| Source | Test | Coverage |
|--------|------|----------|
| `admin/` routes | `admin-lifecycle.test.ts`, `admin-firewall-routes.test.ts` | ✅ |
| `admin/ensure/` | `admin/ensure/route.test.ts` | ✅ |
| `admin/logs/` | `admin/logs/route.test.ts` | ✅ |
| `admin/snapshot/` | `admin/snapshot/route.test.ts` | ✅ |
| `admin/snapshots/` | `admin/snapshots/route.test.ts` | ✅ |
| `admin/snapshots/restore/` | `admin/snapshots/restore/route.test.ts` | ✅ |
| `admin/ssh/` | `admin/ssh/route.test.ts` | ✅ |
| `admin/stop/` | `admin/stop/route.test.ts` | ✅ |
| `auth/` routes | `auth/auth-routes.test.ts`, `auth/auth-enforcement.test.ts` | ✅ |
| `channels/summary/` | `channels/summary/route.test.ts` | ✅ |
| `channels/slack/webhook/` | `channels/slack/webhook/route.test.ts` | ✅ |
| `channels/slack/manifest/` | `channels/slack/manifest/route.test.ts` | ✅ |
| `channels/slack/test/` | `channels/slack/test/route.test.ts` | ✅ |
| `channels/telegram/webhook/` | `channels/telegram/webhook/route.test.ts` | ✅ |
| `channels/telegram/preview/` | `channels/telegram/preview/route.test.ts` | ✅ |
| `channels/discord/webhook/` | `channels/discord/webhook/route.test.ts` | ✅ |
| `channels/discord/register-command/` | `channels/discord/register-command/route.test.ts` | ✅ |
| `cron/drain-channels/` | `cron/drain-channels/route.test.ts` | ✅ |
| `firewall/` | `firewall/route.test.ts` | ✅ |
| `firewall/allowlist/` | `firewall/allowlist/route.test.ts` | ✅ |
| `firewall/promote/` | `firewall/promote/route.test.ts` | ✅ |
| `firewall/test/` | `firewall/test/route.test.ts` | ✅ |
| `health/` | `health/route.test.ts` | ✅ |
| `status/` | `status/route.test.ts` | ✅ |
| `gateway/` | `gateway/route.test.ts` | ✅ |

### `src/server/smoke/` (Meta-tests)
| Source | Test | Coverage |
|--------|------|----------|
| `full-smoke.test.ts` | (self) | ✅ Tier 1: happy-path lifecycle |
| `route-smoke.test.ts` | (self) | ✅ Tier 3: route-level E2E |
| `concurrency-smoke.test.ts` | (self) | ✅ Tier 2: failure & concurrency |

### `src/test-utils/`
| Source | Test | Coverage |
|--------|------|----------|
| `harness.ts` | `harness-isolation.test.ts` | ✅ Isolation, teardown, env restore |
| `fake-fetch.ts` | `harness-isolation.test.ts` | ✅ Request-object fix, reset behavior |
| `fake-sandbox-controller.ts` | `controller.test.ts` | ✅ Interface conformance |
| `route-caller.ts` | — | 🔥 Exercised by every route test |
| `webhook-builders.ts` | — | 🔥 Exercised by channel route tests |
| `auth-fixtures.ts` | — | 🔥 Exercised by auth + admin tests |
| `assertions.ts` | — | 🔥 Exercised by smoke tests |

---

## Verification Protocol (Updated)

Always use `pnpm test` — never `bun test`. The canonical verification sequence:

```bash
pnpm test          # 854 tests across all tiers
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm build         # Next.js production build
```

All four must pass before work is considered done.
