# Contributing

## Commands

```bash
npm install
npm run dev
npm run lint
npm test
npm run typecheck
npm run build
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
npm run verify:observability-pass   # preflight + launch-verify + deploy-requirements + lifecycle tests
npm run check:deploy-readiness      # machine-checkable deployment readiness report
npm run check:verify-contract       # docs/env contract guard for README.md, CLAUDE.md, CONTRIBUTING.md, .env.example
```

### Remote smoke testing

```bash
npm run smoke:remote -- --base-url https://my-app.vercel.app
npm run smoke:remote -- --base-url https://my-app.vercel.app --destructive --timeout 180
```

See `CLAUDE.md` for the full list of smoke test flags.

## Architecture

The app has two planes:

- **Control plane** — a single metadata record in Upstash Redis (or in-memory for local dev). Tracks sandbox ID, snapshot ID, lifecycle status, firewall state, and the OpenClaw gateway token.
- **Enforcement plane** — the `@vercel/sandbox` SDK creates, restores, snapshots, and updates the sandbox network policy.

### Request flow

1. User opens `/gateway`
2. App authenticates the request
3. If no sandbox is running, schedules create/restore with `after()` and returns a waiting page
4. Once ready, proxies the request to the sandbox on port `3000`
5. HTML responses are modified to rewrite WebSocket connections and inject the gateway token

### Lifecycle states

`uninitialized` → `creating` → `setup` → `booting` → `running` → `stopped`

Also: `restoring`, `error`

### Restore fast path

`src/server/openclaw/restore-assets.ts` splits restore files into static (scripts, skills) and dynamic (`openclaw.json`). Static files use a manifest-based hash (`RestorePhaseMetrics.assetSha256`) to skip redundant uploads. Readiness is probed locally first, then publicly. Per-phase timings are recorded as `RestorePhaseMetrics` on metadata.

### Firewall modes

| Mode | Network policy |
| ---- | -------------- |
| `disabled` | `allow-all` |
| `learning` | `allow-all` (observes shell commands to discover domains) |
| `enforcing` | `{ allow: [...] }` |

### Channel delivery

1. Public webhook validates the platform signature or secret.
2. If the sandbox is already running, Telegram forwards raw updates to the native handler on port `8787`; Slack forwards to the gateway's Slack events endpoint.
3. Otherwise Telegram may send a boot message, then the route starts `drainChannelWorkflow` via Workflow DevKit. Slack and Discord also enter the workflow path when they cannot use the fast path.
4. The workflow restores the sandbox if needed, sends the message to `POST /v1/chat/completions`, and delivers the reply back to the originating channel.
5. `@vercel/queue` is used for launch verification only, via `/api/queues/launch-verify`.

## Project structure

```
src/
├── app/
│   ├── api/                    # Auth, admin, firewall, status, health
│   ├── gateway/[[...path]]/    # Reverse proxy route
│   └── admin/                  # Admin page
├── components/
│   └── admin-shell.tsx         # Admin UI
├── server/
│   ├── auth/                   # Session cookies and Vercel OAuth
│   ├── channels/               # Channel adapters and workflow delivery
│   ├── firewall/               # Domain parsing, state, policy mapping
│   ├── openclaw/               # Config generation and bootstrap
│   ├── proxy/                  # HTML injection, waiting page
│   ├── sandbox/                # Lifecycle orchestration
│   └── store/                  # Upstash and in-memory backends
└── shared/
    └── types.ts                # Metadata and firewall types
```

## Environment variables

Full reference:

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `UPSTASH_REDIS_REST_URL` | Required on Vercel | Persistent store endpoint. Local dev uses the in-memory store. |
| `UPSTASH_REDIS_REST_TOKEN` | Required on Vercel | Persistent store token. Paired with the URL above. |
| `ADMIN_SECRET` | Required (`admin-secret` mode) | Secret exchanged for an encrypted session cookie via `/api/auth/login`. Auto-generated locally if unset. |
| `CRON_SECRET` | Required on Vercel | Authenticates `/api/cron/watchdog` (every 5 min, wakes stopped sandboxes for cron jobs) and the optional `/api/cron/drain-channels` diagnostic backstop. Missing on Vercel is a hard failure in the deployment contract. |
| `VERCEL_AUTH_MODE` | No | `admin-secret` (default) or `sign-in-with-vercel` |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | Sign-in mode | OAuth client ID |
| `VERCEL_APP_CLIENT_SECRET` | Sign-in mode | OAuth client secret |
| `SESSION_SECRET` | Required on Vercel (`sign-in-with-vercel` mode) | Cookie encryption secret. Must be explicitly set on deployed Vercel environments. |
| `AI_GATEWAY_API_KEY` | No | Optional fallback when Vercel OIDC is unavailable (e.g. local dev without `vercel env pull`). OIDC is the default on deployed Vercel. |
| `OPENCLAW_PACKAGE_SPEC` | No | OpenClaw version to install (defaults to `openclaw@latest`). On Vercel deployments, the deployment contract **warns** — it does not fail — when unset or unpinned (e.g. `openclaw@latest`). The runtime still falls back to `openclaw@latest`, but restores are non-deterministic. Pin to an exact version like `openclaw@1.2.3`. |
| `OPENCLAW_SANDBOX_VCPUS` | No | vCPU count for sandbox create and snapshot restore (valid: 1, 2, 4, 8; default: 1). Keep fixed during benchmarks. |
| `OPENCLAW_SANDBOX_SLEEP_AFTER_MS` | No | How long the sandbox stays alive after last activity, in milliseconds (60000–2700000; default: 1800000 = 30 min). Heartbeat and touch-throttle intervals are derived proportionally. Existing running sandboxes cannot be shortened in place. If you increase this value, the next touch/heartbeat can top the sandbox timeout up to the new target. If you decrease it, the lower value becomes exact on the next create or restore. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | No | Enables protected webhook delivery when Deployment Protection is on. Slack and Discord URLs use it when configured; Telegram intentionally does not and relies on webhook-secret validation instead. |
| `NEXT_PUBLIC_APP_URL` | No | Base origin override |
| `NEXT_PUBLIC_BASE_DOMAIN` | No | Preferred external host for webhook URLs |
| `BASE_DOMAIN` | No | Legacy alias for `NEXT_PUBLIC_BASE_DOMAIN` |
| `KV_REST_API_URL` | No | Alias for Upstash REST URL |
| `KV_REST_API_TOKEN` | No | Alias for Upstash REST token |

## Routes

| Route | Purpose |
| ----- | ------- |
| `/` | Admin shell |
| `/gateway` | Proxied OpenClaw UI |
| `/api/status` | Current sandbox state and heartbeat |
| `/api/admin/ensure` | Trigger create or restore |
| `/api/admin/stop` | Snapshot and stop |
| `/api/admin/preflight` | Deployment readiness checks |
| `/api/admin/launch-verify` | Full launch verification |
| `/api/channels/slack/webhook` | Public Slack webhook |
| `/api/channels/telegram/webhook` | Public Telegram webhook |
| `/api/channels/discord/webhook` | Public Discord interactions endpoint |

## Machine-readable operations surfaces

- `GET /api/admin/preflight` returns a `PreflightPayload` with `checks`, `actions`, `nextSteps`, and per-channel readiness.
- `POST /api/admin/launch-verify` returns a `LaunchVerificationPayload`. Send `Accept: application/x-ndjson` to stream phase events (`LaunchVerificationStreamEvent`) for automation.
- `GET /api/admin/watchdog` returns the cached `WatchdogReport`; `POST /api/admin/watchdog` runs a fresh check. Each report contains `WatchdogCheck` entries.

See `CLAUDE.md` for the complete route table and detailed system documentation.

See `SECURITY.md` for vulnerability reporting.
See `CODE_OF_CONDUCT.md` for community participation standards.
