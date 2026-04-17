# Contributing

## Commands

```bash
pnpm install
pnpm dev
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Tests use Node's built-in `node:test` runner.

### Verification

Use this for all local automation and CI:

```bash
node scripts/verify.mjs
```

Run a subset:

```bash
node scripts/verify.mjs --steps=test,typecheck
```

Additional verification commands:

```bash
pnpm verify:observability-pass   # preflight + launch-verify + deploy-requirements + lifecycle tests
pnpm check:deploy-readiness      # machine-checkable deployment readiness report
pnpm check:verify-contract       # docs/env contract guard for README.md, CLAUDE.md, CONTRIBUTING.md, .env.example
```

### Maintainer observability contract

Prefer these non-interactive entrypoints in local automation and CI:

- `node scripts/verify.mjs`
- `node scripts/check-deploy-readiness.mjs`
- `pnpm verify:observability-pass`
- `pnpm check:verify-contract`

Structured outputs to rely on:

- `node scripts/verify.mjs` emits JSON Lines to stdout (`verify.start`, `verify.step.start`, `verify.step.finish`, `verify.summary`) and mirrors child command output to stderr.
- `node scripts/check-deploy-readiness.mjs --json-only` emits machine-readable JSON and exits with stable numeric codes (`0` = pass, `1` = contract-fail, `2` = bad-args, `3` = fetch-fail, `4` = bad-response).
- `POST /api/admin/launch-verify` supports both JSON and NDJSON (`Accept: application/x-ndjson`).
- `GET /api/admin/watchdog` and `POST /api/admin/watchdog` return `WatchdogReport`.

Policy details that matter to automation:

- `webhook-bypass` is diagnostic-only and must not be treated as a hard deployment blocker by itself.
- `warningChannelIds` is deprecated (compatibility alias for `failingChannelIds`); prefer `failingChannelIds` in new automation.
- Admin-visible URLs must never include the `x-vercel-protection-bypass` secret.

### Remote smoke testing

```bash
pnpm smoke:remote --base-url https://my-app.vercel.app
pnpm smoke:remote --base-url https://my-app.vercel.app --destructive --timeout 180
```

See `CLAUDE.md` for the full list of smoke test flags.

## Architecture

The app has two planes:

- **Control plane** — a single metadata record in Redis (or in-memory for local dev). Tracks sandbox name, lifecycle status, firewall state, and the OpenClaw gateway token.
- **Enforcement plane** — the `@vercel/sandbox` v2 beta SDK creates, resumes, stops, and updates the sandbox network policy. Sandboxes are persistent (auto-snapshot on stop, auto-resume on get).

### Request flow

1. User opens `/gateway`
2. App authenticates the request
3. If no sandbox is running, schedules create/resume with `after()` and returns a waiting page
4. Once ready, proxies the request to the sandbox on port `3000`
5. HTML responses are modified to rewrite WebSocket connections and inject the gateway token

### Lifecycle states

`uninitialized` → `creating` → `setup` → `booting` → `running` → `stopped`

Also: `error`

Note: The `restoring` status from v1 snapshot-based flow has been removed. With v2 persistent sandboxes, resume goes through the same `creating` → `setup` → `booting` path.

### Resume fast path

`src/server/openclaw/restore-assets.ts` splits restore files into static (scripts, skills) and dynamic (`openclaw.json`). Static files use a manifest-based hash (`RestorePhaseMetrics.assetSha256`) to skip redundant uploads. Readiness is probed locally first, then publicly. Per-phase timings are recorded as `RestorePhaseMetrics` on metadata. With v2 persistent sandboxes, resume from stop takes ~10s vs v1's ~5-30s snapshot restore.

### Firewall modes

| Mode | Network policy |
| ---- | -------------- |
| `disabled` | `allow-all` |
| `learning` | `allow-all` (observes shell commands to discover domains) |
| `enforcing` | `{ allow: [...] }` |

### Channel delivery

1. Public webhook validates the platform signature or secret.
2. If the sandbox is already running, Telegram forwards raw updates to the native handler on port `8787`; Slack forwards to the gateway's Slack events endpoint.
3. Otherwise Telegram may send a boot message, then the route starts `drainChannelWorkflow` via Workflow DevKit. Slack also enters the workflow path when it cannot use the fast path.
4. The workflow restores the sandbox if needed, sends the message to `POST /v1/chat/completions`, and delivers the reply back to the originating channel.
5. `@vercel/queue` is used for launch verification only, via `/api/queues/launch-verify`.

## Project structure

```
src/
├── app/
│   ├── api/                    # Auth, admin, firewall, status, health
│   └── gateway/[[...path]]/    # Reverse proxy route
├── components/
│   └── designs/command-shell.tsx  # Admin UI (mounted at /)
├── server/
│   ├── auth/                   # Session cookies and Vercel OAuth
│   ├── channels/               # Channel adapters and workflow delivery
│   ├── firewall/               # Domain parsing, state, policy mapping
│   ├── openclaw/               # Config generation and bootstrap
│   ├── proxy/                  # HTML injection, waiting page
│   ├── sandbox/                # Lifecycle orchestration
│   └── store/                  # Redis and in-memory backends
└── shared/
    └── types.ts                # Metadata and firewall types
```

## Environment variables

Full reference:

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `REDIS_URL` | Required on Vercel | Persistent store endpoint. Provision via the Vercel Marketplace (Redis Cloud) or point at any Redis-wire-protocol endpoint. Local dev uses the in-memory store when unset. |
| `KV_URL` | No | Legacy alias for `REDIS_URL` (set by the Vercel KV integration). The app prefers `REDIS_URL` but falls back to `KV_URL`. |
| `ADMIN_SECRET` | Required (`admin-secret` mode) | Secret exchanged for an encrypted session cookie via `/api/auth/login`. Auto-generated locally if unset. |
| `CRON_SECRET` | Required on Vercel | Authenticates `/api/cron/watchdog` (every 5 min, wakes stopped sandboxes for cron jobs). Missing on Vercel is a hard failure in the deployment contract. |
| `VERCEL_AUTH_MODE` | No | `admin-secret` (default) or `sign-in-with-vercel` |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | Sign-in mode | OAuth client ID |
| `VERCEL_APP_CLIENT_SECRET` | Sign-in mode | OAuth client secret |
| `SESSION_SECRET` | Optional (`admin-secret` mode) / Required on Vercel (`sign-in-with-vercel` mode) | Cookie encryption secret. In admin-secret mode the app auto-generates a 32-byte value and persists it in Redis on first login. In `sign-in-with-vercel` mode it must be explicitly set on deployed Vercel environments. |
| `AI_GATEWAY_API_KEY` | No | Optional fallback when Vercel OIDC is unavailable (e.g. local dev without `vercel env pull`). OIDC is the default on deployed Vercel. |
| `OPENCLAW_INSTANCE_ID` | No | Optional Redis key namespace. Defaults to `openclaw-single`. Required when multiple deployments share one Redis database. Changing it later points the app at a new namespace and does not migrate existing state. |
| `OPENCLAW_PACKAGE_SPEC` | No | OpenClaw version to install. When unset, the runtime falls back to a pinned known-good version (currently `openclaw@2026.4.12`). On Vercel deployments, the deployment contract **warns** — it does not fail — when unset or unpinned. Pin to an exact version like `openclaw@1.2.3` for deterministic sandbox resumes. |
| `OPENCLAW_SANDBOX_VCPUS` | No | vCPU count for sandbox create and resume (valid: 1, 2, 4, 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | No | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | No | Enables protected webhook delivery when Deployment Protection is on. All channel webhook URLs (Slack, Telegram, WhatsApp, Discord) include the bypass parameter when configured. The app auto-detects active protection and hard-blocks channel connections when it is on but this secret is missing. |
| `NEXT_PUBLIC_APP_URL` | No | Base origin override |
| `NEXT_PUBLIC_BASE_DOMAIN` | No | Preferred external host for webhook URLs |
| `BASE_DOMAIN` | No | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN` |

When you add or change Redis keys, route every key through `src/server/store/keyspace.ts`. Do not hardcode the `openclaw-single` prefix anywhere else.

## Routes

| Route | Purpose |
| ----- | ------- |
| `/` | Admin shell |
| `/gateway` | Proxied OpenClaw UI |
| `/api/status` | Current sandbox state and heartbeat |
| `/api/admin/preflight` | Deployment readiness checks |
| `/api/admin/launch-verify` | Full launch verification |
| `/api/queues/launch-verify` | Private queue consumer used by launch verification |
| `/api/admin/ensure` | Trigger create or resume |
| `/api/admin/stop` | Stop the sandbox (v2 auto-snapshots on stop) |
| `/api/admin/snapshot` | Stop the sandbox (same as stop for now; v2 auto-snapshots) |
| `/api/admin/snapshots/delete` | Delete a past snapshot from Vercel and local history |
| `/api/admin/channel-secrets` | Configure smoke credentials and dispatch signed synthetic channel webhooks. Smoke dispatch uses `buildPublicUrl()` (bypass included) for all channels. |
| `/api/admin/channel-forward-diag` | Read channel forward diagnostic from store |
| `/api/cron/watchdog` | Cron watchdog for health repair and scheduled OpenClaw cron wake |
| `/api/admin/watchdog` | Read cached watchdog report or run a fresh one |
| `/api/channels/slack/install` | Slack OAuth install redirect (requires `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`) |
| `/api/channels/slack/install/callback` | Slack OAuth callback — exchanges code, persists config |
| `/api/channels/slack/webhook` | Public Slack webhook |
| `/api/channels/telegram/webhook` | Public Telegram webhook |
| `/api/channels/whatsapp/webhook` | Public WhatsApp webhook (experimental) |
| `/api/channels/discord` | Discord channel config (experimental) |

## Verification behavior that is easy to miss

- `node scripts/verify.mjs` runs `node scripts/check-queue-consumers.mjs` before the `test` step whenever `test` is included in `--steps`. Expect `verify.step.start` / `verify.step.finish` events for `queue-consumers`.
- `node scripts/check-deploy-readiness.mjs` regenerates `src/app/api/auth/protected-route-manifest.json` before calling `/api/admin/launch-verify` and includes `bootstrapExposure` in the JSON result. A stale manifest or any unauthenticated admin/firewall route is a contract failure.
- On Deployment Protection-enabled deployments, pass `--protection-bypass "$VERCEL_AUTOMATION_BYPASS_SECRET"` so automation can reach the app.

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

### Launch verification completion signals

The server emits a terminal `launch_verify.completed` structured log that summarizes the full verification outcome in one machine-friendly object:

```ts
type LaunchVerifyCompletionLog = {
  ok: boolean;
  mode: "safe" | "destructive";
  phaseCount: number;
  totalMs: number;
  channelReady: boolean;
  failingCheckIds: string[];
  requiredActionIds: string[];
  recommendedActionIds: string[];
  failingChannelIds: Array<"slack" | "telegram">;
  dynamicConfigVerified: boolean | null;
  dynamicConfigReason?: "hash-match" | "hash-miss" | "no-snapshot-hash";
  repaired: boolean | null;
  configReconciled: boolean | null;
  configReconcileReason?: string;
};
```

Example:

```json
{
  "event": "launch_verify.completed",
  "ok": true,
  "mode": "destructive",
  "phaseCount": 5,
  "totalMs": 70234,
  "channelReady": true,
  "failingCheckIds": [],
  "requiredActionIds": [],
  "recommendedActionIds": [],
  "failingChannelIds": [],
  "dynamicConfigVerified": true,
  "dynamicConfigReason": "hash-match",
  "repaired": false,
  "configReconciled": true,
  "configReconcileReason": "already-fresh"
}
```

Use this log for machine-readable postmortems. Use persisted `channelReadiness` for deployment-level readiness state that survives the request.

See `CLAUDE.md` for the complete route table and detailed system documentation.

## Documentation structure

| Document | Contents |
| -------- | -------- |
| `README.md` | Quick-start guide and deploy button |
| `docs/environment-variables.md` | Full environment variable reference |
| `docs/api-reference.md` | Machine-readable endpoints, payloads, automation contracts |
| `docs/deployment-protection.md` | Bypass secrets, webhook URL behavior |
| `CONTRIBUTING.md` | Architecture, routes, testing, development workflows |
| `CLAUDE.md` | AI assistant instructions and system internals |

See `SECURITY.md` for vulnerability reporting.
See `CODE_OF_CONDUCT.md` for community participation standards.
