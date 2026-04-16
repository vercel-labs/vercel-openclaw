# CLAUDE.md

This file explains how to work in `vercel-openclaw`.

## Project goal

`vercel-openclaw` is a single-instance Next.js app that manages exactly one Vercel Sandbox running OpenClaw.

The app handles:

- auth in front of the proxy
- on-demand sandbox create and resume (persistent sandboxes with auto-snapshot on stop)
- proxying the OpenClaw UI at `/gateway`
- HTML injection for WebSocket rewriting and gateway token handoff
- learning and enforcing egress firewall state
- Slack, Telegram, WhatsApp (experimental), and Discord (experimental) channel webhooks through the app

The app does not handle:

- multiple sandboxes
- per-sandbox passwords

## Commands

Run these from the repository root:

```bash
npm install
npm run dev
npm run lint
npm test
npm run typecheck
npm run build
```

Tests use `node:test`. Run `npm test` or use `node scripts/verify.mjs --steps=test`.

### Remote smoke testing

```bash
npm run smoke:remote -- --base-url https://my-app.vercel.app
npm run smoke:remote -- --base-url https://my-app.vercel.app --destructive --timeout 180
npm run smoke:remote -- --base-url https://my-app.vercel.app --json-only --auth-cookie "session=..."
npm run smoke:remote -- --base-url https://my-app.vercel.app --request-timeout 10
```

Flags:

- `--base-url` (required) — the deployed app URL to test
- `--destructive` — include destructive phases (ensure, stop, resume). Omit for safe read-only checks only.
- `--timeout` — timeout in seconds for polling phases (default: 120)
- `--request-timeout` — per-request fetch timeout in seconds (default: 30)
- `--auth-cookie` — auth cookie value, overrides `SMOKE_AUTH_COOKIE` env var. The raw value is never logged.
- `--json-only` — suppress all human-readable stderr output; emit only the JSON report to stdout

Environment:

- `SMOKE_AUTH_COOKIE` — encrypted session cookie for `sign-in-with-vercel` mode. Not needed for the default `admin-secret` mode. Overridden by `--auth-cookie` if both are set.

Output:

- Structured JSON report to stdout: `{ schemaVersion: 1, passed: boolean, phases: PhaseResult[], totalMs: number }`
- Human-readable progress to stderr (suppressed by `--json-only`)
- Exit code 0 (all pass) or 1 (any fail)

Safe phases (always run): `health`, `status`, `gatewayProbe`, `firewallRead`, `channelsSummary`, `sshEcho`, `chatCompletions`, `channelRoundTrip`.
Destructive phases (opt-in): `ensureRunning`, `chatCompletions`, `channelRoundTrip`, `channelWakeFromSleep`, `chatCompletions` (post-wake), `selfHealTokenRefresh`.

Channel phases (`channelRoundTrip`, `channelWakeFromSleep`) call `POST /api/admin/channel-secrets` with `{ channel, body }` so the server signs and dispatches synthetic webhooks. Raw channel secrets never leave the server, and the phases still verify the full ingestion + drain + completions pipeline. They gracefully skip if no channels are configured.

## Routes

| Route | Purpose |
| ----- | ------- |
| `/api/admin/preflight` | Deploy-readiness report: public origin, webhook bypass, durable state, AI Gateway auth detection |
| `/api/admin/launch-verify` | Full launch verification: preflight + queue delivery probe + sandbox ensure + chat completions + wake from sleep (destructive) |
| `/api/queues/launch-verify` | Private Vercel Queues consumer for launch verification probes (not publicly reachable on Vercel) |
| `/api/admin/ensure` | Trigger sandbox create or resume |
| `/api/admin/stop` | Stop the sandbox (v2 auto-snapshots on stop) |
| `/api/admin/snapshot` | Stop the sandbox (same as stop for now; v2 auto-snapshots on stop) |
| `/api/admin/snapshots/delete` | Delete a past snapshot from Vercel and local history |
| `/api/admin/channel-secrets` | Configure smoke credentials and dispatch server-signed synthetic channel webhooks. Raw secrets are never returned. Smoke dispatch URLs use `buildPublicUrl()` (bypass included when configured) for all channels. |
| `/api/admin/channel-forward-diag` | Read channel forward diagnostic from store |
| `/api/channels/slack/install` | Slack OAuth install initiation |
| `/api/channels/slack/install/callback` | Slack OAuth callback |
| `/api/cron/watchdog` | Runs daily via Vercel Cron (Hobby-compatible default). Health-checks running sandboxes, repairs stuck states, and **wakes stopped sandboxes when OpenClaw cron jobs are due**. Pro users can increase frequency up to every minute in `vercel.json`. |
| `/api/admin/watchdog` | GET reads cached watchdog report; POST runs a fresh check |

## Cron wake

OpenClaw has a built-in cron scheduler (`croner` library) that persists jobs to `~/.openclaw/cron/jobs.json`. When the sandbox sleeps, the scheduler dies. The watchdog bridges this gap:

1. **Before stop** (`stopSandbox()`): reads `jobs.json` from the sandbox, extracts the earliest `nextRunAtMs` across all enabled jobs, and saves it to the host store as `openclaw-single:cron-next-wake-ms`. Also persists the full `jobs.json` content to `openclaw-single:cron-jobs-json`.
2. **On heartbeat** (`touchRunningSandbox()`): keeps both the wake time and jobs JSON fresh in the store, so they survive even when the sandbox times out naturally without an explicit stop.
3. **On each watchdog run** (`/api/cron/watchdog`): if the sandbox is stopped (or in a recoverable error state) and the saved wake time has passed, calls `ensureSandboxReady()` to resume the sandbox. OpenClaw's native cron handles everything from there. The default cron schedule is daily (Hobby-compatible); Pro users can increase up to every minute in `vercel.json`.
4. **After resume**: checks if `jobs.json` is empty on the resumed sandbox. If jobs were lost but the store has a copy, writes the stored jobs back and restarts the gateway so the cron module loads them.
5. **After wake**: the wake key is cleared only when the cron restore outcome is `no-store-jobs`, `already-present`, or `restored-verified`. If resume fails or is unverified, the key is retained so the next watchdog run can retry. OpenClaw reschedules the next run internally, and the next heartbeat will persist the updated time.

The watchdog never runs chat completions, delivers messages, or interacts with channels. It only wakes the sandbox — OpenClaw handles the rest.

Watchdog observability notes:

- `watchdog.run_completed` logs `{ deploymentId, status, sandboxStatus, triggeredRepair, consecutiveFailures }`
- Each `WatchdogReport` contains per-check `{ id, status, durationMs, message }` entries
- `cron.wake` is the check id for scheduled sandbox wake attempts
- Cron wake success messages include whether the wake key was cleared or retained based on `cronRestoreOutcome`

### Cron jobs persistence (important)

Cron jobs can be lost during resume in edge cases: partial writes during gateway restarts, config-triggered re-initialization, or auto-snapshots taken after a transient empty state. OpenClaw's gateway normally preserves `jobs.json` across restarts (it reads, normalizes, and writes back with a `.bak` safety backup), but the store-based persistence acts as a belt-and-suspenders safety net.

- **Store keys**: `openclaw-single:cron-next-wake-ms` (wake timestamp) and `openclaw-single:cron-jobs-json` (full jobs payload)
- **Save path**: `stopSandbox()` and `touchRunningSandbox()` both persist to the store
- **Resume path**: after gateway readiness in the resume flow, if the store has jobs and the sandbox has none, the jobs are written back and the gateway is restarted via `OPENCLAW_GATEWAY_RESTART_SCRIPT_PATH`. When the persistent sandbox already preserved the jobs (the common case), no restart is needed.
- **Metrics**: `RestorePhaseMetrics.cronRestoreOutcome` records `no-store-jobs`, `already-present`, `restored-verified`, `restore-failed`, `restore-unverified`, or `store-invalid`.
- **Watchdog clear behavior**: `/api/cron/watchdog` clears the saved wake key only after `no-store-jobs`, `already-present`, or `restored-verified`; otherwise it retains the wake key so the next run can retry.

If you change the resume flow, ensure the cron check happens **after** the gateway is ready and **before** marking the sandbox as `running`.

To use cron in OpenClaw, the `tools.profile` must be `"full"` (not the default `"coding"`) so the `cron` tool is available to the agent. The gateway must also have `OPENCLAW_GATEWAY_PORT` set to match the `--port` flag so internal tools can connect.

## Architecture

### `src/server/public-url.ts`

Shared external URL resolution and webhook URL construction.

Responsibilities:

- resolve a canonical public origin from `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_DOMAIN`, `BASE_DOMAIN`, forwarded request headers, or Vercel system env vars (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_URL`)
- expose `getPublicOrigin(request?: Request): string`
- expose `getProtectionBypassSecret(): string | null`
- expose `buildPublicUrl(path: string, request?: Request): string`
- append `x-vercel-protection-bypass=<VERCEL_AUTOMATION_BYPASS_SECRET>` when the bypass secret is available (regardless of auth mode)

Channel webhook URL construction lives in `src/server/channels/webhook-urls.ts`. The convenience wrappers in `src/server/channels/state.ts` (`buildSlackWebhookUrl`, `buildTelegramWebhookUrl`) delegate to `buildChannelWebhookUrl()` in that module. All channel delivery URLs use `buildPublicUrl` (bypass secret appended when available), including the Slack app manifest's `request_url`. Slack preserves the `x-vercel-protection-bypass` query parameter on its URL verification POST and on every subsequent webhook call, so it's required to pass through Vercel Deployment Protection. See [Vercel KB: Test a Slack bot with a Vercel preview deployment](https://vercel.com/kb/guide/test-slack-bot-with-vercel-preview-deployment).

Admin-visible surfaces (preflight payload, status responses, UI) must use `buildPublicDisplayUrl()` instead of `buildPublicUrl()`. The display variant omits the `x-vercel-protection-bypass` query parameter so secrets are never leaked to the browser or API consumers.

Practical rule:

- use `buildPublicUrl()` only for outbound delivery or registration URLs that may need the bypass secret
- use `buildPublicDisplayUrl()` for admin JSON, UI, diagnostics, docs examples, and any operator-visible surface

Logging notes:

- `public_url.built` logs redacted delivery URL diagnostics
- `public_display_url.built` logs admin-visible URL diagnostics with `bypassApplied: false`
- Never show `x-vercel-protection-bypass` in UI, status JSON, docs, or example payloads

### `src/server/deploy-preflight.ts`

Machine-checkable config readiness report consumed by `/api/admin/preflight`.

Checks: `public-origin`, `webhook-bypass` (diagnostic only: pass or warn, never fail), `store`, `ai-gateway`, `openclaw-package-spec` (warn on Vercel when unpinned, runtime falls back to a pinned known-good version), `auth-config` (fail when sign-in-with-vercel vars are missing), `bootstrap-exposure`, and `cron-secret` (warn on Vercel when only `ADMIN_SECRET` is available; fail only when both `CRON_SECRET` and `ADMIN_SECRET` are missing).

The authoritative readiness check is `POST /api/admin/launch-verify` (`src/app/api/admin/launch-verify/route.ts`), which runs preflight as its first phase and then verifies runtime behavior: queue loopback delivery via `/api/queues/launch-verify`, sandbox ensure, gateway chat completions, and wake-from-sleep recovery (destructive mode). `scripts/check-deploy-readiness.mjs` consumes launch-verify by default.

Store requirement policy: missing Upstash is a hard fail (`status: "fail"`) on Vercel deployments but a warning (`status: "warn"`) in non-Vercel/local environments. This applies to both connectability and preflight checks.

Observability notes:

- `deployment_contract.built` logs `{ ok, authMode, storeBackend, aiGatewayAuth, onVercel, requirementIds }`
- `deploy_preflight.built` logs `{ ok, authMode, publicOrigin, webhookBypassEnabled, webhookBypassRecommended, storeBackend, aiGatewayAuth, cronSecretConfigured, cronSecretExplicitlyConfigured, cronSecretSource, actionCount, consumedContractIds }`
- `launch_verify.blocking_check` logs `{ blocking, failingCheckIds, requiredActionIds, recommendedActionIds, skipPhaseIds }`
- `launch_verify.preflight_evaluated` logs `LaunchVerificationDiagnostics`
- `LaunchVerificationDiagnostics.warningChannelIds` is deprecated; prefer `failingChannelIds`

`GET /api/admin/preflight` returns a `PreflightPayload`:

```ts
{
  ok: boolean;
  authMode: "admin-secret" | "sign-in-with-vercel";
  publicOrigin: string | null;
  webhookBypassEnabled: boolean;
  webhookBypassRecommended: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  cronSecretExplicitlyConfigured: boolean;
  cronSecretSource: "cron-secret" | "admin-secret" | "missing";
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: { slack, telegram, discord };
  channels: Record<ChannelName, ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
  nextSteps: PreflightNextStep[];
}
```

`POST /api/admin/launch-verify` is the public readiness entrypoint. It supports standard JSON responses and NDJSON streaming when the client sends `Accept: application/x-ndjson`. Runtime phases are `preflight`, `queuePing`, `ensureRunning`, `chatCompletions`, and `wakeFromSleep` (destructive mode only). If preflight fails, the runtime phases are skipped.

- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.

`channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` path for the current deployment.

Failure semantics that are easy to miss:

- `payload.ok` can still be `false` after `ensureRunning` succeeds if dynamic config verification fails after restore.
- `runtime.dynamicConfigVerified=false` means the most recent restore used stale runtime/channel config relative to current deployment metadata.
- `sandboxHealth.configReconciled=false` means the sandbox came up but runtime config could not be safely brought back in sync.
- `failingChannelIds` is the canonical machine-readable channel failure list.
- `warningChannelIds` is a deprecated compatibility alias and should not be used in new automation.

## Control plane

State lives in one metadata record described in `src/shared/types.ts`.

Channel config is stored in that same metadata record. Durable webhook queues and session history use store-backed side keys.

Backends:

- `src/server/store/upstash-store.ts`
- `src/server/store/memory-store.ts`

Selection happens in `src/server/store/store.ts`.

Rules:

- prefer the Upstash REST backend for persistent behavior
- the memory backend is for local development only
- any change to metadata shape should be reflected in `ensureMetaShape`

## Lifecycle

Main files:

- `src/server/sandbox/lifecycle.ts`
- `src/server/sandbox/controller.ts`

The project uses `@vercel/sandbox@^2.0.0-beta` with persistent sandboxes. Sandboxes are created with `{ name: "oc-xxx", persistent: true }` and auto-snapshot on stop. Resume from stop uses `Sandbox.create()` which handles name-conflict (409) by falling back to `get()` for auto-resume. There is no manual `snapshot()` call — v2 handles this automatically.

Important behavior:

- `ensureSandboxRunning()` schedules create or resume work with `after()` and returns a waiting state to the caller
- `stopSandbox()` stops the sandbox (v2 auto-snapshots); keeps `sandboxId` in metadata for resume
- `snapshotSandbox()` currently delegates to the same stop flow
- `touchRunningSandbox()` extends sandbox timeout
- `probeGatewayReady()` fetches the sandbox root and checks for readiness (accepts any HTTP status, not just 200 with openclaw-app marker)

Sandbox identification uses `sandbox.name` (human-readable names like `oc-prj-rmayazjosjflloz94grssevda4yr`) rather than system-generated `sandboxId` values. The controller uses `sandbox.update({ networkPolicy })` for firewall policy (replacing the deprecated `updateNetworkPolicy()`).

Gateway launch uses shell `setsid ... &` (detached SDK commands don't work reliably for openclaw). Process termination uses `ps/grep/kill` pattern instead of `pkill` (which returns exit 255 on v2 API).

Statuses:

- `uninitialized`
- `creating`
- `setup`
- `booting`
- `running`
- `stopped`
- `error`

If you change lifecycle behavior, keep the waiting-page flow intact. The proxy depends on it.

### Resume fast path

`src/server/openclaw/restore-assets.ts` owns the restore asset split:

- **static files**: startup script, force-pair script, skill markdown, skill scripts, and the built-in image-gen override
- **dynamic files**: `openclaw.json` (rewritten with the current proxy origin and API key)

On resume, dynamic files are always rewritten. Static files are only rewritten when `${OPENCLAW_STATE_DIR}/.restore-assets-manifest.json` has a different `sha256`. This manifest-based skipping avoids redundant uploads on repeat resumes when the app version has not changed.

Readiness is checked in two stages:

1. **local-first readiness** — `curl http://localhost:3000/` inside the sandbox (accepts any HTTP response, not just 200)
2. **public readiness** — fetch through the proxied route URL

This separates sandbox boot failures from proxy/DNS failures and keeps resumes fast.

Dynamic restore config verification is hash-based: `snapshotConfigHash` is compared against `computeGatewayConfigHash()`, and restore metrics record `dynamicConfigHash`, `dynamicConfigReason`, and `skippedDynamicConfigSync`.

### `lastRestoreMetrics`

`SingleMeta.lastRestoreMetrics` records per-phase timings using this shape:

```ts
type RestorePhaseMetrics = {
  sandboxCreateMs: number;
  tokenWriteMs: number;
  assetSyncMs: number;
  startupScriptMs: number;
  forcePairMs: number;
  firewallSyncMs: number;
  localReadyMs: number;
  publicReadyMs: number;
  totalMs: number;
  skippedStaticAssetSync: boolean;
  skippedDynamicConfigSync?: boolean;
  dynamicConfigHash?: string | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  assetSha256: string | null;
  vcpus: number;
  recordedAt: number;
  bootOverlapMs?: number;
  skippedPublicReady?: boolean;
  cronRestoreOutcome?: CronRestoreOutcome;
};
```

These metrics are stored on metadata after every resume and are visible via `/api/status`.

## OpenClaw bootstrap

Main files:

- `src/server/openclaw/config.ts`
- `src/server/openclaw/bootstrap.ts`

Bootstrap responsibilities:

- install `openclaw`
- write `openclaw.json`
- write the gateway token file
- write the restore startup script
- wait for the gateway to become healthy

The AI Gateway API key is **not** written to disk — it is injected via network policy header transform (see Firewall section).

On readiness timeout, `openclaw.gateway_wait_exhausted` is logged (Vercel function logs + admin log buffer) with last probe summary, HTTP probe without `-f`, OpenClaw log tail, and port/process snapshot.

The startup script also installs shell hooks used for firewall learning.

## Proxy

Main files:

- `src/app/gateway/[[...path]]/route.ts`
- `src/server/proxy/proxy-route-utils.ts`
- `src/server/proxy/htmlInjection.ts`
- `src/server/proxy/waitingPage.ts`

Critical rules:

- auth must happen before proxying any HTML that contains the injected gateway token
- do not remove the WebSocket rewrite logic without replacing it with an equivalent approach
- preserve the heartbeat `POST /api/status` behavior used by the injected script
- block or rewrite upstream redirects so the app does not hand the browser to an external origin unexpectedly

## Firewall

Main files:

- `src/server/firewall/domains.ts`
- `src/server/firewall/policy.ts`
- `src/server/firewall/state.ts`

Mode mapping (without AI Gateway token):

- `disabled` -> `"allow-all"`
- `learning` -> `"allow-all"`
- `enforcing` -> `{ allow: [...] }`

Mode mapping (with AI Gateway token — always uses object form):

- `disabled` / `learning` -> `{ allow: { "ai-gateway.vercel.sh": [{ transform }], "*": [] } }`
- `enforcing` -> `{ allow: { "<domain>": [], ..., "ai-gateway.vercel.sh": [{ transform }] } }`

### AI Gateway credential brokering

The AI Gateway API key never enters the sandbox. Instead, it is injected as an `Authorization: Bearer <token>` header at the sandbox firewall layer via network policy `transform` rules. This protects against prompt injection attacks that might try to exfiltrate the credential — there is nothing inside the sandbox to steal.

Key implementation details:

- `buildAiGatewayTransformRules(token)` in `src/server/firewall/policy.ts` builds the transform rules, reused by main sandbox and worker sandboxes
- `toNetworkPolicy()` accepts an optional `aiGatewayToken` and always returns the object form when provided, regardless of firewall mode
- `ai-gateway.vercel.sh` is always present in the allow list (even in enforcing mode) so the gateway can reach the AI service
- Token refresh calls `applyFirewallPolicyToSandbox()` which updates the network policy via `sandbox.update({ networkPolicy })` — no file writes or gateway restarts needed
- `OPENAI_BASE_URL` is still set as an env var inside the sandbox so code knows where to send requests; the transform handles authentication transparently
- Worker sandboxes pass `networkPolicy` with transforms at create time (fresh creates, not snapshot restores)

Learning flow:

- shell commands are written to `/tmp/shell-commands-for-learning.log`
- status polling ingests that log
- domains are extracted and stored in metadata

If you change learning behavior, keep it deterministic and testable.

## Channels

Main files:

- `src/server/channels/driver.ts`
- `src/server/channels/state.ts`
- `src/server/channels/webhook-urls.ts`
- `src/server/channels/connectability.ts`
- `src/server/channels/slack/adapter.ts`
- `src/server/channels/telegram/adapter.ts`
- `src/server/channels/telegram/bot-api.ts`
- `src/server/channels/whatsapp/adapter.ts`
- `src/server/channels/whatsapp/whatsapp-api.ts`
- `src/server/channels/discord/adapter.ts`
- `src/server/channels/discord/discord-api.ts`

Channel delivery flow:

1. the public webhook route validates the platform signature or secret
2. **Telegram fast path**: if the sandbox is running, the route forwards the raw update to OpenClaw's native Telegram handler on port 8787 and returns 200. This preserves full native Telegram features (slash commands, media, inline keyboards, etc.)
3. **Telegram stopped path / Slack / WhatsApp / Discord**: the route sends a boot message ("🦞 Waking up…"), then calls `start(drainChannelWorkflow)` from `workflow/api`
4. the workflow step (`processChannelStep`) restores the sandbox if needed, then sends the message to `POST /v1/chat/completions` on the OpenClaw gateway
5. the app delivers the reply back to the originating channel
6. the workflow step deletes the boot message after processing

Channel delivery uses Workflow DevKit (`workflow` package) as the primary durable transport. The `withWorkflow()` wrapper in `next.config.ts` enables the `"use workflow"` and `"use step"` directives. Launch verification uses a separate `@vercel/queue` consumer at `/api/queues/launch-verify`.

### Telegram webhook architecture

OpenClaw's `openclaw.json` config includes `webhookUrl` pointing to the app's public Telegram webhook route. When OpenClaw boots, it calls `setWebhook` with this URL — registering the **app's** endpoint, not the sandbox's own. The native Telegram handler still listens on `127.0.0.1:8787` for the fast-path forwarding.

Key config fields in `buildGatewayConfig()`:
- `webhookUrl` — app's public route (e.g. `https://app.example.com/api/channels/telegram/webhook`)
- `webhookSecret` — shared secret for webhook validation (must be threaded through both create and restore paths)
- `webhookPort` — 8787 (local listener)
- `webhookHost` — `127.0.0.1`
- `webhookPath` — `/telegram-webhook` (local path)

Both `SANDBOX_PORTS` in lifecycle.ts must include port 8787 alongside 3000.

Behavior:

- Slack uses threaded replies; fast path forwards to `/slack/events` on the gateway when running
- Telegram uses webhook-secret validation; fast path forwards to native handler on port 8787 when running; boot message sent from webhook route when stopped
- WhatsApp (experimental) uses webhook-proxied mode with signature validation; delivery via workflow when sandbox is stopped
- Discord (experimental) uses webhook-proxied mode; delivery via workflow when sandbox is stopped

### Channel connectability and 409 guards

`src/server/channels/connectability.ts` computes whether a channel can be connected before credentials are saved. All channel config routes (Slack, Telegram, WhatsApp, Discord) enforce this check at the top of their `PUT` handler.

Hard blockers (cause `canConnect: false`):

- canonical public HTTPS webhook URL cannot be resolved
- AI Gateway auth is not OIDC on a Vercel deployment (`unavailable`)
- missing Upstash store on a Vercel deployment (durable state required for channel reliability)

Warnings only (do not block connect):

- missing Upstash store in local/non-Vercel environments

`buildChannelConnectability()` and `buildChannelConnectabilityReport()` are **async** — all call sites must use `await` or `await Promise.all([...])`.

Guard pattern used in each channel route:

```ts
const connectability = await buildChannelConnectability("<channel>", request);
if (!connectability.canConnect) {
  return buildChannelConnectBlockedResponse(auth, connectability);
}
```

Shared blocked response (HTTP 409):

```json
{
  "error": {
    "code": "CHANNEL_CONNECT_BLOCKED",
    "message": "Cannot connect <channel> until deployment blockers are resolved."
  },
  "connectability": {
    "channel": "<channel>",
    "canConnect": false,
    "status": "fail",
    "webhookUrl": null,
    "issues": [...]
  }
}
```

## Auth

Main files:

- `src/server/auth/admin-auth.ts`
- `src/server/auth/admin-secret.ts`
- `src/server/auth/session.ts`
- `src/server/auth/vercel-auth.ts`

Supported modes:

- `admin-secret` (default)
- `sign-in-with-vercel` (optional)

The app uses admin-secret auth by default. Operators set `ADMIN_SECRET` as an environment variable and exchange it for an encrypted session cookie via `/api/auth/login`. In local development, a secret is auto-generated and stored in the memory store if `ADMIN_SECRET` is not set. The `/api/setup` endpoint is sealed on Vercel deployments (returns 410).

Notes:

- `admin-secret` is the default if `VERCEL_AUTH_MODE` is unset
- admin auth accepts either `Authorization: Bearer <admin-secret>` or the encrypted `openclaw_admin` session cookie
- CSRF is enforced on cookie-based mutation requests but not bearer token requests
- Vercel Deployment Protection is supported via `VERCEL_AUTOMATION_BYPASS_SECRET`. The app auto-detects active protection at runtime (self-probe of `/api/health`) and hard-blocks channel connections when protection is active but bypass is not configured. Hobby plans cannot enable Deployment Protection, so this only affects Pro/Enterprise deployments.
- `sign-in-with-vercel` uses encrypted cookie sessions and verifies the ID token against Vercel's JWKS
- access tokens are refreshed before expiry
- refresh failure should clear the session and force a new login

## Admin UI

Main files:

- `src/components/designs/command-shell.tsx` — production admin UI mounted at `/`
- `src/components/admin-shell.tsx` — legacy control surface still mounted at `/admin` as a fallback

The admin page is intentionally small. It is a control surface, not a dashboard framework.

**Terminal tab:** Shows the current sandbox ID and a copy-paste `npx sandbox connect <id>` command for an interactive shell via the [Vercel Sandbox CLI](https://vercel.com/docs/vercel-sandbox). Users run `npx sandbox login` first. If connect returns 404, append `--scope TEAM_SLUG --project PROJECT_NAME`, or set optional `NEXT_PUBLIC_SANDBOX_SCOPE` / `NEXT_PUBLIC_SANDBOX_PROJECT` so the UI pre-fills those flags.

## Server log ring buffer

`src/server/log.ts` keeps an in-memory ring buffer of the last 1000 log entries, served via `GET /api/admin/logs`. **Debug-level entries are excluded from the ring buffer** — they only go to `console.debug` (visible in Vercel function logs). This prevents high-frequency diagnostic logs from evicting operationally important entries.

When adding new `logInfo` calls to code that runs on every request (status polling, connectability checks, URL resolution), use `logDebug` instead. The admin UI polls `/api/status` multiple times per second; each info-level log from that path evicts one operational log (webhook events, workflow results, lifecycle transitions) from the buffer. Use `logInfo` only for events that operators need to see in the admin logs panel.

## Important implementation constraints

- Do not add `export const runtime = "nodejs"` to route handlers. This repo uses `cacheComponents: true` in `next.config.ts`, and explicit `runtime` exports break the Next.js 16 build.
- Keep the sandbox exposed on ports `3000` (gateway) and `8787` (Telegram native handler) unless you update bootstrap, lifecycle, proxy, and docs together. Both ports must be in `SANDBOX_PORTS`.
- `POST /api/admin/snapshot` currently stops the sandbox (v2 auto-snapshots on stop). If you change that to a hot snapshot flow, update the README and this file.
- If you add environment variables, update `.env.example`, `README.md`, and this file in the same change.
- If you change metadata shape, update tests and migration logic in `ensureMetaShape`.
- All new Redis keys must go through `src/server/store/keyspace.ts` — never hardcode the `openclaw-single` prefix.
- Telegram `webhookSecret` must flow through ALL config paths: `buildGatewayConfig()`, `buildDynamicResumeFiles()`, `syncRestoreAssetsIfNeeded()`, and `computeGatewayConfigHash()`. Missing it causes OpenClaw config validation failure ("webhookUrl requires webhookSecret").
- `_setSandboxControllerForTesting()` only works when `NODE_ENV=test`. In production, `getSandboxController()` always returns the real `@vercel/sandbox` v2 beta SDK wrapper. This prevents fake sandbox names from contaminating Upstash metadata.
- Upstash store only connects on deployed Vercel runtimes (`isVercelDeployment()`). Local dev and CI always use the memory store, even if Upstash env vars are present.

## Verification

Use this command for all automation and CI in this repository:

```bash
node scripts/verify.mjs
```

This command prepends `node_modules/.bin`, runs the repository's own
`lint`, `test`, `typecheck`, and `build` scripts, emits JSON lines, and exits
non-zero on the first failing step. Do not invoke bare `npm` or `tsx`
directly from automation.

Run a subset of steps:

```bash
node scripts/verify.mjs --steps=test,typecheck
```

For docs-only changes that touch operator instructions or env names, also run locally:

```bash
npm run check:verify-contract
```

This guards the documented deployment contract across `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `.env.example`.

## AI Gateway auth helpers (`src/server/env.ts`)

- `isVercelDeployment(): boolean` — returns `true` when any of `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, or `VERCEL_PROJECT_PRODUCTION_URL` is set. Use this when behavior must differ between deployed Vercel runtimes and local/non-Vercel execution.

- `getAiGatewayBearerTokenOptional(): Promise<string | undefined>` — resolves an OIDC token via `@vercel/oidc`. Returns `undefined` when OIDC is unavailable. For local dev, run `vercel link && vercel env pull` to get OIDC credentials. Use `_setAiGatewayTokenOverrideForTesting()` in tests instead of mocking `@vercel/oidc`.

- `getAiGatewayAuthMode(): Promise<"oidc" | "api-key" | "unavailable">` — returns `"oidc"` when OIDC resolves, `"api-key"` when `AI_GATEWAY_API_KEY` is set, or `"unavailable"` otherwise. Used by preflight and channel connectability.

## Environment variables relevant to deployment contract

These variables are checked by `buildDeploymentContract()` in `src/server/deployment-contract.ts`:

| Variable | Context | Policy |
| -------- | ------- | ------ |
| `CRON_SECRET` | Recommended on Vercel | Authenticates `/api/cron/watchdog`. When unset, the runtime falls back to `ADMIN_SECRET`. The deployment contract **warns** (not fails) on Vercel when only `ADMIN_SECRET` is available. Set `CRON_SECRET` separately if you want independent rotation for cron authentication. Missing both `CRON_SECRET` and `ADMIN_SECRET` on Vercel is a hard failure. |
| `UPSTASH_REDIS_REST_URL` | All deployments | Required for persistent state. Provision via Vercel Marketplace. |
| `UPSTASH_REDIS_REST_TOKEN` | All deployments | Required for persistent state. Paired with the URL above. |
| `OPENCLAW_INSTANCE_ID` | All environments | Optional. Namespace token for Redis key isolation. On Vercel deployments, automatically uses `VERCEL_PROJECT_ID` when unset, giving each project its own namespace. Falls back to `openclaw-single` in local/non-Vercel environments. Can be set explicitly to override auto-detection. Changing it later points the app at a new namespace; it does not migrate existing state. |
| `OPENCLAW_PACKAGE_SPEC` | All environments | Optional locally, recommended on Vercel. When unset, the runtime falls back to a pinned known-good version (currently `openclaw@2026.4.12`). On Vercel deployments, the deployment contract **warns** — it does not fail — when unset or unpinned. Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox resumes. |
| `OPENCLAW_SANDBOX_VCPUS` | All environments | Optional. vCPU count for sandbox create and resume (valid: 1, 2, 4, 8; default: 1). Keep this fixed during benchmarks so resume timings stay comparable. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | All environments | Optional. How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | `sign-in-with-vercel` mode | Required for OAuth flow. |
| `VERCEL_APP_CLIENT_SECRET` | `sign-in-with-vercel` mode | Required for OAuth flow. |
| `SESSION_SECRET` | `sign-in-with-vercel` on Vercel | Required. Must be explicitly set — do not rely on silent derivation from the Upstash token. |
| `SLACK_CLIENT_ID` | All environments | Optional. Slack app client ID. When all three `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` are set, the admin panel offers one-click OAuth install instead of manual credential entry. |
| `SLACK_CLIENT_SECRET` | All environments | Optional. Slack app client secret. Paired with `SLACK_CLIENT_ID`. |
| `SLACK_SIGNING_SECRET` | All environments | Optional. Slack app signing secret. Used for webhook signature verification when the bot token is obtained via the OAuth install flow. |

`scripts/check-verifier-contract.mjs` enforces that every env name in the deployment contract also appears in `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `.env.example`. It uses word-boundary matching so that e.g. `BASE_DOMAIN` is not falsely found inside `NEXT_PUBLIC_BASE_DOMAIN`.

## Current sharp edges

- The memory store is not safe for production persistence.
- Firewall learning is based on shell command observation, not full traffic inspection.
- Channel webhook durability depends on the store backend. Use Upstash when channels matter.

## Design Context

See `.impeccable.md` for the full design reference. Key principles:

1. **Signal over decoration** — Every visual element must carry information. No ornamental gradients, shadows, or illustrations. Color is reserved for status and brand.
2. **Density with clarity** — Pack information tight but keep it scannable. Use Geist Mono eyebrow labels, consistent spacing scales, and strong typographic hierarchy.
3. **Quiet confidence** — Subtle transitions (150ms ease), restrained animations, no jarring motion. Status communicates through color and text.
4. **Vercel-native feel** — Geist fonts, monochrome palette, 1px borders, pill badges, same component vocabulary as Vercel Dashboard.
5. **Operator-first** — Optimize for someone who already knows what everything means. Concise labels, direct controls, CLI-copy patterns are first-class.

**Aesthetic**: Dark-only, technical, minimal. References: Vercel Dashboard, Linear. Anti-references: colorful dashboards, playful/consumer UI.
**Users**: Solo developers managing their own OpenClaw sandbox.
**Accessibility**: WCAG AA.

<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
