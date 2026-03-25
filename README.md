<p align="center"><strong>Research Preview</strong></p>

<p align="center">
  <img src="public/openclaw-logo.svg" width="80" height="80" alt="OpenClaw" />
</p>

<h1 align="center">Deploy OpenClaw on Vercel</h1>

<p align="center">
  Get a personal OpenClaw instance running in a Vercel Sandbox — with one click.
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fvercel-openclaw.git&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17&env=ADMIN_SECRET&envDescription=Password%20for%20the%20admin%20UI.%20Also%20used%20to%20secure%20cron%20jobs%20unless%20CRON_SECRET%20is%20set%20separately.&project-name=openclaw&repository-name=openclaw"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
</p>

---

## Setup

The deploy button auto-provisions an Upstash Redis database (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) via the Vercel Marketplace integration and asks for `ADMIN_SECRET` (password for the admin UI). The admin secret also secures cron jobs automatically — set `CRON_SECRET` separately only if you want a distinct value. AI Gateway auth is handled automatically via OIDC on deployed Vercel environments.

## First visit

1. Open the deployment and sign in with your `ADMIN_SECRET`.
4. Visit `/gateway` or use the admin panel to start the sandbox.
5. Run launch verification before connecting channels.

## What you can do

- **Use OpenClaw** — the full OpenClaw UI is proxied at `/gateway`.
- **Stop & restore** — save a snapshot of your sandbox and restore it later. Useful if you want to roll back after experimenting.
- **Connect channels** — wire up Slack or Telegram so people can talk to your OpenClaw instance from chat. Configure each one from the admin panel. Normal channel delivery uses Workflow DevKit. Deployment verification is triggered via `POST /api/admin/launch-verify`, which internally probes the private `/api/queues/launch-verify` consumer. Smoke testing via `/api/admin/channel-secrets` dispatches server-signed synthetic webhooks — these use bypass-enabled URLs for all channels including Telegram, unlike provider-facing Telegram registration which intentionally omits the bypass parameter.
- **Firewall** — the app can learn which domains your agent talks to, then lock egress down to only those domains.

## Required on Vercel

| Variable | Purpose |
| -------- | ------- |
| `ADMIN_SECRET` | Password for the admin UI. Also authenticates `/api/cron/watchdog` unless `CRON_SECRET` is set separately. |

AI Gateway auth uses Vercel OIDC automatically on deployed Vercel environments.

## Optional: auth and cron

| Variable | Purpose |
| -------- | ------- |
| `CRON_SECRET` | Separate secret for `/api/cron/watchdog`. Falls back to `ADMIN_SECRET` when not set. |
| `AI_GATEWAY_API_KEY` | Static fallback when Vercel OIDC is unavailable. Deployed Vercel still prefers OIDC first. |

### Experimental: sign-in-with-vercel

Set `VERCEL_AUTH_MODE=sign-in-with-vercel` to use Vercel OAuth instead of `ADMIN_SECRET`.

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | OAuth client ID. |
| `VERCEL_APP_CLIENT_SECRET` | OAuth client secret. |
| `SESSION_SECRET` | Explicit cookie encryption secret (required on Vercel). Do not rely on derivation from the Upstash token. |

## Optional: pin the OpenClaw version

By default the app installs `openclaw@latest`, which is non-deterministic across deploys. On Vercel deployments, the deployment contract **warns** — it does not fail — when `OPENCLAW_PACKAGE_SPEC` is unset or unpinned (e.g. `openclaw@latest`). The runtime still falls back to `openclaw@latest`, but restores are non-deterministic. Pin to an exact version like `openclaw@1.2.3`.

| Variable | Purpose |
| -------- | ------- |
| `OPENCLAW_INSTANCE_ID` | Optional Redis key namespace. Defaults to `openclaw-single`. Required when multiple forks or deployments share one Upstash database. Changing it later points the app at a new namespace; it does not migrate existing state. |
| `OPENCLAW_PACKAGE_SPEC` | Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox restores and comparable benchmarks. When unset, the runtime falls back to `openclaw@latest` and the deployment contract warns on Vercel. |
| `OPENCLAW_SANDBOX_VCPUS` | vCPU count for sandbox create/restore (1, 2, 4, or 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |

## Optional: Deployment Protection and webhooks

`VERCEL_AUTOMATION_BYPASS_SECRET` is diagnostic-only: missing it does not fail preflight by itself, but protected third-party webhooks can be blocked before app auth runs.

| Variable | Purpose |
| -------- | ------- |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Lets protected webhook requests reach the app when Vercel Deployment Protection is enabled. |

Channel behavior:
- Slack webhook URLs include the bypass query parameter when the secret is configured.
- Telegram intentionally does not include the bypass query parameter. Telegram validates via the `x-telegram-bot-api-secret-token` header, and adding the bypass query parameter can cause `setWebhook` to silently drop registration. On protected deployments, Telegram needs a Deployment Protection Exception or another protection-compatible path.

### Delivery URLs vs operator-visible URLs

These are intentionally different surfaces:

- Slack delivery URLs may include `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured.
- Telegram intentionally does not include the bypass query parameter because Telegram webhook registration can silently fail when it is present.
- Admin-visible payloads, rendered UI, connectability output, and docs examples must use display URLs that never expose the bypass secret.

Examples:

```
Delivery URL (Slack):    https://app.example.com/api/channels/slack/webhook?x-vercel-protection-bypass=[redacted]
Display URL (Slack):     https://app.example.com/api/channels/slack/webhook
Delivery URL (Telegram): https://app.example.com/api/channels/telegram/webhook
Display URL (Telegram):  https://app.example.com/api/channels/telegram/webhook
```

In code: use `buildPublicUrl()` only for outbound delivery or registration URLs that may need the bypass secret. Use `buildPublicDisplayUrl()` for admin JSON, UI, diagnostics, docs examples, and any operator-visible surface.

## Optional: override the public origin

The app resolves its canonical public URL from Vercel system variables automatically. If you need to override it (e.g. custom domain, non-Vercel host), set one of:

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_APP_URL` | Full origin override, e.g. `https://my-app.example.com` |
| `NEXT_PUBLIC_BASE_DOMAIN` | Preferred external host for webhook URLs |
| `BASE_DOMAIN` | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN` |

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

`channelReadiness.ready` is only true after destructive launch verification passes the full `preflight` → `queuePing` → `ensureRunning` → `chatCompletions` → `wakeFromSleep` path for the current deployment.

Example `POST /api/admin/launch-verify` response (destructive mode, all phases passing):

```json
{
  "ok": true,
  "mode": "destructive",
  "startedAt": "2026-03-24T08:00:00.000Z",
  "completedAt": "2026-03-24T08:01:10.000Z",
  "phases": [
    { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
    { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
    { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
    { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
    { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." }
  ],
  "runtime": {
    "packageSpec": "openclaw@1.2.3",
    "installedVersion": "1.2.3",
    "drift": false,
    "expectedConfigHash": "abc123",
    "lastRestoreConfigHash": "abc123",
    "dynamicConfigVerified": true,
    "dynamicConfigReason": "hash-match"
  },
  "sandboxHealth": {
    "repaired": false,
    "configReconciled": true,
    "configReconcileReason": "already-fresh"
  },
  "diagnostics": {
    "blocking": false,
    "failingCheckIds": [],
    "requiredActionIds": [],
    "recommendedActionIds": [],
    "warningChannelIds": [],
    "failingChannelIds": [],
    "skipPhaseIds": []
  },
  "channelReadiness": {
    "deploymentId": "dpl_123",
    "ready": true,
    "verifiedAt": "2026-03-24T08:01:10.000Z",
    "mode": "destructive",
    "wakeFromSleepPassed": true,
    "failingPhaseId": null,
    "phases": [
      { "id": "preflight", "status": "pass", "durationMs": 120, "message": "All 8 config checks passed." },
      { "id": "queuePing", "status": "pass", "durationMs": 840, "message": "Vercel Queue delivered callback msg_123." },
      { "id": "ensureRunning", "status": "pass", "durationMs": 41200, "message": "Sandbox started and gateway ready." },
      { "id": "chatCompletions", "status": "pass", "durationMs": 910, "message": "Gateway replied with exact text: launch-verify-ok" },
      { "id": "wakeFromSleep", "status": "pass", "durationMs": 22000, "message": "Wake-from-sleep probe passed." }
    ]
  }
}
```

`warningChannelIds` is kept only for backward compatibility. New automation should consume `failingChannelIds`.

### Launch verification fields that matter to automation

`POST /api/admin/launch-verify` exposes more than phase pass/fail:

- `runtime.expectedConfigHash` — hash derived from the current channel/runtime config.
- `runtime.lastRestoreConfigHash` — hash recorded during the most recent restore.
- `runtime.dynamicConfigVerified` — `true` when those hashes match, `false` when they drift, `null` when no restore hash is available yet.
- `runtime.dynamicConfigReason` — one of `hash-match`, `hash-miss`, or `no-snapshot-hash`.
- `sandboxHealth.repaired` — whether launch verification had to recover sandbox health.
- `sandboxHealth.configReconciled` — whether stale runtime config was reconciled successfully.
- `sandboxHealth.configReconcileReason` — one of `already-fresh`, `rewritten-and-restarted`, `rewrite-failed`, `restart-failed`, `sandbox-unavailable`, `error`, or `skipped`.

Automation should treat `payload.ok=false` as authoritative even when the main runtime phases look healthy, because stale dynamic config that could not be reconciled is a hard failure.

## Structured output contracts

These interfaces are intended for non-interactive automation.

### `node scripts/verify.mjs`

- Emits JSON Lines to stdout.
- Human-readable child process output goes to stderr.
- Event names:
  - `verify.start`
  - `verify.step.start`
  - `verify.step.finish`
  - `verify.summary`
  - `verify.config_error`
  - `verify.fatal`

Example output:

```jsonl
{"event":"verify.start","timestamp":"2026-03-24T08:00:00.000Z","ok":true,"root":"/repo","steps":["contract","lint","test","typecheck","build"],"pathIncludesNodeModulesBin":true}
{"event":"verify.step.start","timestamp":"2026-03-24T08:00:00.100Z","step":"contract","command":"node scripts/check-verifier-contract.mjs"}
{"event":"verify.step.finish","timestamp":"2026-03-24T08:00:01.200Z","step":"contract","ok":true,"exitCode":0,"durationMs":1100,"signal":null}
{"event":"verify.summary","timestamp":"2026-03-24T08:00:42.000Z","ok":true,"results":[{"step":"contract","exitCode":0},{"step":"lint","exitCode":0},{"step":"test","exitCode":0},{"step":"typecheck","exitCode":0},{"step":"build","exitCode":0}]}
```

### `node scripts/check-deploy-readiness.mjs`

- Primary remote readiness gate for deployed instances.
- Exit codes:
  - `0` = pass
  - `1` = contract-fail
  - `2` = bad-args
  - `3` = fetch-fail
  - `4` = bad-response

Example usage:

```bash
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --mode destructive --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --auth-cookie "$SMOKE_AUTH_COOKIE" --preflight-only --json-only
node scripts/check-deploy-readiness.mjs --base-url "$OPENCLAW_BASE_URL" --admin-secret "$ADMIN_SECRET" --protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET" --json-only
```

### API payloads

- `GET /api/admin/preflight` returns `PreflightPayload`.
- `GET /api/admin/launch-verify` returns persisted `ChannelReadiness` for the current deployment.
- `POST /api/admin/launch-verify` returns `LaunchVerificationPayload & { channelReadiness: ChannelReadiness }`.
- When streaming with `Accept: application/x-ndjson`, the terminal `result` event carries the same extended payload including `channelReadiness`.
- `GET /api/admin/watchdog` returns `WatchdogReport`.

Compatibility note:

- `LaunchVerificationDiagnostics.warningChannelIds` is deprecated.
- Prefer `LaunchVerificationDiagnostics.failingChannelIds` in new automation.

## Verification behavior that is easy to miss

- `node scripts/verify.mjs` runs `node scripts/check-queue-consumers.mjs` before the `test` step whenever `test` is included in `--steps`. Expect `verify.step.start` / `verify.step.finish` events for `queue-consumers`.
- `node scripts/check-deploy-readiness.mjs` regenerates `src/app/api/auth/protected-route-manifest.json` before calling `/api/admin/launch-verify` and includes `bootstrapExposure` in the JSON result. A stale manifest or any unauthenticated admin/firewall route is a contract failure.
- On Deployment Protection-enabled deployments, pass `--protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` so automation can reach the app.

## Local development

```bash
npm install
vercel link && vercel env pull   # pulls OIDC credentials for AI Gateway
npm run dev                      # http://localhost:3000
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, testing, and development workflows.
