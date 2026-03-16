# CLAUDE.md

This file explains how to work in `vercel-openclaw`.

## Project goal

`vercel-openclaw` is a single-instance Next.js app that manages exactly one Vercel Sandbox running OpenClaw.

The app handles:

- auth in front of the proxy
- on-demand sandbox create and restore
- proxying the OpenClaw UI at `/gateway`
- HTML injection for WebSocket rewriting and gateway token handoff
- learning and enforcing egress firewall state
- Slack, Discord, and Telegram channel webhooks through the app

The app does not handle:

- multiple sandboxes
- per-sandbox passwords
- admin bearer tokens

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
- `--destructive` — include destructive phases (ensure, snapshot, restore). Omit for safe read-only checks only.
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
Destructive phases (opt-in): `ensureRunning`, `chatCompletions`, `channelRoundTrip`, `channelWakeFromSleep`, `chatCompletions` (post-wake).

Channel phases (`channelRoundTrip`, `channelWakeFromSleep`) read signing secrets from `/api/admin/channel-secrets`, construct properly-signed webhooks, and verify the full ingestion + drain + completions pipeline. They gracefully skip if no channels are configured.

## Routes

| Route | Purpose |
| ----- | ------- |
| `/api/admin/preflight` | Deploy-readiness report: public origin, webhook bypass, durable state, AI Gateway auth (config-only) |
| `/api/admin/launch-verify` | Full launch verification: preflight + queue delivery probe + sandbox ensure + chat completions + wake from sleep (destructive) |
| `/api/queues/launch-verify` | Private Vercel Queues consumer for launch verification probes (not publicly reachable on Vercel) |
| `/api/admin/ensure` | Trigger sandbox create or restore |
| `/api/admin/stop` | Snapshot and stop the sandbox |
| `/api/admin/snapshot` | Snapshot and stop (same as stop for now) |
| `/api/admin/channel-secrets` | Expose signing secrets for smoke-test webhook construction |
| `/api/queues/channels/slack` | Private Vercel Queues consumer for Slack delivery (not publicly reachable on Vercel) |
| `/api/queues/channels/telegram` | Private Vercel Queues consumer for Telegram delivery (not publicly reachable on Vercel) |
| `/api/queues/channels/discord` | Private Vercel Queues consumer for Discord delivery (not publicly reachable on Vercel) |
| `/api/cron/drain-channels` | Optional diagnostic backstop — replays queued channel work when `CRON_SECRET` is configured. Vercel Queues is the primary delivery mechanism |

## Architecture

### `src/server/public-url.ts`

Shared external URL resolution and webhook URL construction.

Responsibilities:

- resolve a canonical public origin from `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_DOMAIN`, `BASE_DOMAIN`, forwarded request headers, or Vercel system env vars (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL`, `VERCEL_URL`)
- expose `getPublicOrigin(request?: Request): string`
- expose `getProtectionBypassSecret(): string | null`
- expose `buildPublicUrl(path: string, request?: Request): string`
- append `x-vercel-protection-bypass=<VERCEL_AUTOMATION_BYPASS_SECRET>` when the bypass secret is available (regardless of auth mode)

All channel webhook URL builders (`buildSlackWebhookUrl`, `buildTelegramWebhookUrl`, `buildDiscordPublicWebhookUrl` in `src/server/channels/state.ts`) delegate to `buildPublicUrl`. This guarantees Slack, Telegram, and Discord webhook URLs include the protection bypass query parameter when the secret is configured.

### `src/server/deploy-preflight.ts`

Machine-checkable config readiness report consumed by `/api/admin/preflight`.

Checks: `public-origin`, `webhook-bypass`, `store`, `ai-gateway`, `drain-recovery` (always passes — Vercel Queues is the primary delivery mechanism).

The authoritative readiness check is `POST /api/admin/launch-verify` (`src/app/api/admin/launch-verify/route.ts`), which runs preflight as its first phase and then verifies runtime behavior: Vercel Queue loopback delivery via `/api/queues/launch-verify`, sandbox ensure, gateway chat completions, and wake-from-sleep recovery (destructive mode). `scripts/check-deploy-readiness.mjs` consumes launch-verify by default.

Store requirement policy: missing Upstash is a hard fail (`status: "fail"`) on Vercel deployments but a warning (`status: "warn"`) in non-Vercel/local environments. This applies to both connectability and preflight checks.

`GET /api/admin/preflight` returns a `PreflightPayload`:

```ts
{
  ok: boolean;
  authMode: "admin-secret" | "sign-in-with-vercel";
  publicOrigin: string | null;
  webhookBypassEnabled: boolean;
  storeBackend: "upstash" | "memory";
  aiGatewayAuth: "oidc" | "api-key" | "unavailable";
  cronSecretConfigured: boolean;
  publicOriginResolution: PublicOriginResolution | null;
  webhookDiagnostics: { slack, telegram, discord };
  channels: Record<"slack" | "telegram" | "discord", ChannelConnectability>;
  actions: PreflightAction[];
  checks: PreflightCheck[];
}
```

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

Main file:

- `src/server/sandbox/lifecycle.ts`

Important behavior:

- `ensureSandboxRunning()` schedules create or restore work with `after()` and returns a waiting state to the caller
- `stopSandbox()` snapshots and stops
- `snapshotSandbox()` currently delegates to the same snapshot-and-stop flow
- `touchRunningSandbox()` extends sandbox timeout
- `probeGatewayReady()` fetches the sandbox root and checks for `openclaw-app`

Statuses:

- `uninitialized`
- `creating`
- `setup`
- `booting`
- `running`
- `stopped`
- `restoring`
- `error`

If you change lifecycle behavior, keep the waiting-page flow intact. The proxy depends on it.

## OpenClaw bootstrap

Main files:

- `src/server/openclaw/config.ts`
- `src/server/openclaw/bootstrap.ts`

Bootstrap responsibilities:

- install `openclaw`
- write `openclaw.json`
- write the gateway token file
- write the AI Gateway key file
- write the restore startup script
- wait for the gateway to become healthy

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

Mode mapping:

- `disabled` -> `allow-all`
- `learning` -> `allow-all`
- `enforcing` -> `{ allow: [...] }`

Learning flow:

- shell commands are written to `/tmp/shell-commands-for-learning.log`
- status polling ingests that log
- domains are extracted and stored in metadata

If you change learning behavior, keep it deterministic and testable.

## Channels

Main files:

- `src/server/channels/driver.ts`
- `src/server/channels/state.ts`
- `src/server/channels/connectability.ts`
- `src/server/channels/slack/adapter.ts`
- `src/server/channels/telegram/adapter.ts`
- `src/server/channels/telegram/bot-api.ts`
- `src/server/channels/discord/adapter.ts`
- `src/server/channels/discord/application.ts`

Channel delivery flow:

1. the public webhook route validates the platform signature or secret
2. the handler publishes a message to a Vercel Queue topic (`channel-slack`, `channel-telegram`, or `channel-discord`)
3. a private queue consumer route under `/api/queues/channels/*` restores the sandbox if needed
4. the consumer sends the message to `POST /v1/chat/completions` on the OpenClaw gateway
5. the app delivers the reply back to the originating channel

Private queue consumers are configured in `vercel.json` and are not publicly reachable on Vercel.

Behavior:

- Slack uses threaded replies
- Telegram uses webhook-secret validation and Bot API replies
- Discord uses deferred interaction responses and can register `/ask`
- `/api/cron/drain-channels` is an optional diagnostic backstop when `CRON_SECRET` is configured — not the primary delivery path

Channel delivery uses Vercel Queues as the primary durable transport. If you change queue semantics, keep the webhook acknowledgment path fast and preserve retry behavior.

### Local queue development

Running `@vercel/queue` locally requires OIDC credentials:

```bash
vercel link
vercel env pull
```

This writes the OIDC credentials that `@vercel/queue` needs for local `send` and `handleCallback` calls. On deployed Vercel environments, queue auth is automatic.

### Channel connectability and 409 guards

`src/server/channels/connectability.ts` computes whether a channel can be connected before credentials are saved. All three channel config routes (Slack, Telegram, Discord) enforce this check at the top of their `PUT` handler.

Hard blockers (cause `canConnect: false`):

- canonical public HTTPS webhook URL cannot be resolved
- AI Gateway auth is not OIDC on a Vercel deployment (falls back to `api-key` or `unavailable`)
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

Discord also has a separate 409 for endpoint conflicts:

```json
{
  "error": {
    "code": "DISCORD_ENDPOINT_CONFLICT",
    "message": "Discord interactions endpoint is already set to a different URL. Set forceOverwriteEndpoint=true to replace it."
  },
  "currentUrl": "<currentUrl>",
  "desiredUrl": "<desiredUrl>"
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

The app uses admin-secret auth by default. An admin secret is auto-generated and stored in Upstash (zero-config). The secret is revealed once via `/api/setup` and exchanged for an encrypted session cookie via `/api/auth/login`.

Notes:

- `admin-secret` is the default if `VERCEL_AUTH_MODE` is unset
- admin auth accepts either `Authorization: Bearer <admin-secret>` or the encrypted `openclaw_admin` session cookie
- CSRF is enforced on cookie-based mutation requests but not bearer token requests
- deployment-protection was attempted and abandoned — Vercel's deployment protection blocks channel webhooks from Slack, Telegram, and Discord, and is unavailable on Hobby plans
- `sign-in-with-vercel` uses encrypted cookie sessions and verifies the ID token against Vercel's JWKS
- access tokens are refreshed before expiry
- refresh failure should clear the session and force a new login

## Admin UI

Main file:

- `src/components/admin-shell.tsx`

The admin page is intentionally small. It is a control surface, not a dashboard framework.

## Important implementation constraints

- Do not add `export const runtime = "nodejs"` to route handlers. This repo uses `cacheComponents: true` in `next.config.ts`, and explicit `runtime` exports break the Next.js 16 build.
- Keep the sandbox exposed on port `3000` unless you update bootstrap, lifecycle, proxy, and docs together.
- `POST /api/admin/snapshot` currently snapshots and stops. If you change that to a hot snapshot flow, update the README and this file.
- If you add environment variables, update `.env.example`, `README.md`, and this file in the same change.
- If you change metadata shape, update tests and migration logic in `ensureMetaShape`.

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

## AI Gateway auth helpers (`src/server/env.ts`)

- `isVercelDeployment(): boolean` — returns `true` when any of `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, or `VERCEL_PROJECT_PRODUCTION_URL` is set. Use this when behavior must differ between deployed Vercel runtimes and local/non-Vercel execution.

- `getAiGatewayBearerTokenOptional(): Promise<string | undefined>` — resolves an OIDC token via `@vercel/oidc`. Returns `undefined` when OIDC is unavailable. For local dev, run `vercel link && vercel env pull` to get OIDC credentials. Use `_setAiGatewayTokenOverrideForTesting()` in tests instead of mocking `@vercel/oidc`.

- `getAiGatewayAuthMode(): Promise<"oidc" | "unavailable">` — returns `"oidc"` when the OIDC token resolves, `"unavailable"` otherwise. Used by preflight and channel connectability.

## Environment variables relevant to deployment contract

These variables are checked by `buildDeploymentContract()` in `src/server/deployment-contract.ts`:

| Variable | Context | Policy |
| -------- | ------- | ------ |
| `OPENCLAW_PACKAGE_SPEC` | Vercel deployments | Required. Must be a pinned version like `openclaw@1.2.3`. Local dev falls back to `openclaw@latest` when unset. |
| `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` | `sign-in-with-vercel` mode | Required for OAuth flow. |
| `VERCEL_APP_CLIENT_SECRET` | `sign-in-with-vercel` mode | Required for OAuth flow. |
| `SESSION_SECRET` | `sign-in-with-vercel` on Vercel | Required. Must be explicitly set — do not rely on silent derivation from the Upstash token. |

`scripts/check-verifier-contract.mjs` enforces that every env name in the deployment contract also appears in `README.md`, `CLAUDE.md`, and `.env.example`.

## Current sharp edges

- The memory store is not safe for production persistence.
- Firewall learning is based on shell command observation, not full traffic inspection.
- Channel webhook durability depends on the store backend. Use Upstash when channels matter.
