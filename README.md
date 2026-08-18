# vercel-openclaw

Run [OpenClaw](https://github.com/openclaw/openclaw) in [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

OpenClaw's official Docker image is mirrored into [Vercel Container Registry](https://vercel.com/docs/container-registry) (VCR) as a public repository. Any Vercel account can boot it as a sandbox with one call:

```ts
import { Sandbox } from '@vercel/sandbox';

const sandbox = await Sandbox.create({
  image: 'openclaw-foundation/openclaw/openclaw:latest',
});
```

No Dockerfile, no build step, no bundle pipeline. The image is the same one OpenClaw publishes to `ghcr.io/openclaw/openclaw` (stable channel, `linux/amd64`).

## Quickstart

```bash
cd examples
npm install
vercel link          # any project; the SDK reads its OIDC token
vercel env pull
npm run boot         # boots the image, prints `openclaw --version`
```

`examples/boot.ts` is the smallest end-to-end proof: create a sandbox from the image, run `openclaw --version`, stop.

## The host app (`host/`)

The control plane that makes an OpenClaw sandbox sleep between messages and wake on demand, per [`docs/suspension-spec.md`](docs/suspension-spec.md):

- `app/api/slack/route.ts` — the front door, with two modes. By default the host owns the channel exactly as in PR #2: it verifies Connect, applies host policy/dedupe, invokes `openclaw agent`, and posts the reply. The experimental native mode activates only when both host-bridge variables below are set: it forwards the exact raw envelope to OpenClaw's `/slack/events`, where the Slack plugin applies `channels.slack.*`; plugin Web API calls return through the host proxy. **No Slack credential enters the sandbox in either mode.**
- `lib/slack.ts` — which events start a turn (mentions and DMs, never bot-authored or subtyped events) and how a reply is posted.
- `lib/access.ts` — who may drive the agent. Fails closed on an unset allowlist. Necessary because owning the channel bypasses OpenClaw's own DM allowlists and mention gates.
- `lib/dedupe.ts` — atomic `SET NX EX` claim per Slack `event_id`. Connect retries 5xx up to three times and a cold wake takes ~10s, so without this one mention can start several turns.
- `app/api/cron/idle-check/route.ts` — the scheduler ([`vercel.json`](host/vercel.json), every 5 min): 60 minutes without host-visible activity triggers the suspend attempt.
- `lib/wake.ts` — `ensureAwake()`: resume or create the sandbox, refresh the request-scoped egress policy, migrate versioned persistent config, restart the gateway when needed, and health-check it.
- `lib/agent.ts` — `runAgentTurn()`: used only by the default host-owned mode. It runs one turn as `openclaw agent --message ... --json` inside the VM and returns the reply. Native mode never invokes this path; the Slack plugin starts the agent turn through its normal channel pipeline.
- `lib/model-credentials.ts` — the egress policy. Model access is brokered at the firewall: OpenClaw is configured with a placeholder key and the firewall swaps in either the app's Vercel OIDC token for AI Gateway or a host-owned OpenAI key for `api.openai.com`, so no model credential ever enters the sandbox.
- `lib/suspend.ts` — the verified `gateway.suspend.*` contract (2026.7.2-beta.7): prepare as idle-fence, 2-minute lease, busy/ready/conflict/recovering handling, ceiling force-stop.
- `lib/activity.ts` + tests — the idle clock: which events reset it, 60-minute threshold, extend-timeout rules.

It's a headless API-only Next.js app. Deploy with the Vercel project's **Root Directory set to `host`** — `vercel.json` (the cron schedule) lives there, and without it the idle path silently never runs. Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token; the host holds it, the gateway enforces it |
| `SLACK_CONNECTOR` | Connect connector UID, e.g. `slack/openclaw`. There is no Slack bot token or signing secret to set: Connect mints the token per call and verifies inbound events |
| `OPENCLAW_ALLOWED_SLACK_USERS` | Slack user ids allowed to invoke the agent, comma-separated. **Fails closed**: unset or empty admits nobody |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis-backed activity and de-duplication stores (Upstash REST protocol; `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` also accepted). **Required in production**: without it the idle clock is per-instance memory, the idle path never fires, and retried deliveries start duplicate turns |
| `OPENCLAW_SANDBOX_NAME` | Sandbox name (default `openclaw`) |
| `OPENCLAW_IMAGE` | Image override (default `openclaw-foundation/openclaw/openclaw:latest`) |
| `OPENCLAW_MODEL` | Model for agent turns (default `vercel-ai-gateway/openai/gpt-5.6-sol`), addressed through the official Vercel AI Gateway plugin |
| `OPENAI_API_KEY` | Optional host-only OpenAI key. When `OPENCLAW_MODEL` uses `openai/*`, the Sandbox firewall injects this key on egress to `api.openai.com`; the sandbox receives only the placeholder. |
| `OPENCLAW_SLACK_HOST_BRIDGE_TOKEN` | PoC-only host assertion shared with the sandbox. Set together with the API URL to activate native mode; this is not a Slack credential |
| `OPENCLAW_SLACK_HOST_BRIDGE_API_URL` | PoC-only HTTPS base URL for the host Slack API proxy. Its host is allowlisted without AI Gateway credential injection |
| `CRON_SECRET` | Protects the cron route when set |

### Connecting Slack

Connect registers and owns the Slack app, so there is no manifest to write and no secret to copy. Run both from `host/`, so Connect picks up the project:

```bash
vercel connect create slack --name openclaw --triggers --trigger-path /api/slack
vercel connect attach slack/openclaw --environment production --triggers --trigger-path /api/slack
```

The managed Slack app's defaults already include the scopes and events this bridge needs (`chat:write`, `reactions:write`, `app_mentions:read`, channel history, and DM history); no manual manifest is required. Set `SLACK_CONNECTOR` and `OPENCLAW_ALLOWED_SLACK_USERS` in the production environment, redeploy, invite the app to a channel, and mention it. An accepted message gets an `:eyes:` reaction while OpenClaw wakes and works. Default mode uses one session per Slack channel, shared across users and top-level threads in that channel; different channels remain isolated. Connect's managed Slack app handles mentions and DMs; the old manually-created `/openclaw` slash command is not part of this setup.

The preceding behavior describes the default host-owned mode. The native PoC deliberately does not use `OPENCLAW_ALLOWED_SLACK_USERS`, host mention filtering, host sessions, or `openclaw agent`; it preserves the complete event envelope and leaves those decisions to the existing `channels.slack.*` configuration. The host supplies only verified ingress, wake/routing, and credentialless Slack API transport.

Native-mode scope is intentionally narrow. A text mention can use native allowlists, activation, session/thread mapping, de-duplication, and a threaded reply through the proxy. Follow-up work is still required for proactive/detached sends, private downloads, direct upload URLs, `response_url` callbacks, slash commands and other interactive payloads, streaming clients, method allowlisting, 401 token refresh, rate-limit/retry policy, replay semantics, and routing across multiple Slack installations. Until those seams are bridged, keep `channels.slack.streaming.mode=off` and treat this as a single-install PoC.

For a native proof, run the PoC plugin installer and the host with the same `OPENCLAW_SANDBOX_NAME`. Sandbox port routes are fixed at creation, so an older named sandbox created without port 18789 cannot be switched in place; use a fresh PoC sandbox name.

Trigger forwarding only reaches deployed URLs, so the Slack path cannot be exercised against localhost. If a preview must receive real Slack traffic before production, attach it deliberately and detach it after the test so one event cannot reach both environments:

```bash
vercel connect attach slack/openclaw --environment preview --triggers --trigger-path /api/slack
```

If this project previously used a manually-created Slack app, keep it installed until the Connect path answers one mention. Then uninstall the old app and remove its obsolete `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` variables; leaving both apps installed creates duplicate bot identities and ambiguous deliveries.

Known limitations. Verification proves "a Vercel OIDC token for this project and environment", not "this came from our Slack connector", because that is the boundary the Connect verifier offers. Each delivery has a shared 280-second processing deadline inside the function's 300-second `maxDuration`; wake, configuration, model execution, and reply operations all consume that same budget, with time reserved for a generic Slack failure notice. A longer turn is cut off rather than resumed. OpenClaw scheduled jobs do not yet wake a sleeping sandbox; leave them disabled until the host persists and schedules the gateway's next job time. At the platform session ceiling, a stopped sandbox resumes on the next accepted message rather than immediately. The sandbox session timeout is capped at 45 minutes for Hobby compatibility; the 300-second function and 5-minute cron still require a plan that supports them.

**Live-validated** against `2026.7.2-beta.7`: two full sleep/wake cycles through this code path — gateway boot, health, `prepare` → `ready` → stop → snapshot → resume → gateway restart (`host/scripts/e2e-lifecycle.ts`). End-to-end wake is **~10s** (cold and from snapshot alike); the sandbox's own resume including snapshot restore is sub-second, and ~7s of the total is the OpenClaw gateway booting. The runs also confirmed interrupted work auto-continues after an abrupt stop, and surfaced one upstream issue with held leases (spec, contract question 6). Re-validation is pending a stable release that carries the suspend API. 2026.7.2 never shipped stable: the beta line moved to 2026.8.1, so the target is **2026.8.1 stable**. Verified 2026-08-17 from npm: `latest` is 2026.7.1-2, `beta` is 2026.8.1-beta.2, and the `gateway.suspend.*` triad is present in 2026.8.1-beta.2.

## How the image stays current

OpenClaw's own release CI publishes to VCR, so the image is theirs end to end and this repo carries no mirroring machinery.

- [`vercel-container-registry-publish.yml`](https://github.com/openclaw/openclaw/pull/120058) (merged 2026-08-10) publishes stable, extended-stable and beta releases: default, slim and browser variants across amd64, arm64 and multi-platform indexes. It runs as an independent sibling after the Docker publish and smoke-tests the immutable image in Vercel Sandbox before promoting moving aliases.
- [`docker-image-refresh.yml`](https://github.com/openclaw/openclaw/pull/123348) (merged 2026-08-14) rebuilds the moving tags weekly so `latest` picks up base-image security updates between releases.

Boot-verified from a non-owning Vercel team on 2026-08-17: `latest` and `slim` run OpenClaw 2026.7.1, and `2026.7.2-beta.7` runs in its plain, `-slim` and `-amd64` forms. The `2026.8.1` beta tags did not resolve from VCR at that time, though `2026.8.1-beta.2` was present on ghcr.

## What "public" means

Public VCR repositories are readable by **any Vercel account** ([changelog](https://vercel.com/changelog/vercel-container-registry-repositories-can-now-be-made-public)). Pulls are authenticated: `Sandbox.create()` works from any team, and `docker pull vcr.vercel.com/...` works after `vercel vcr login`. There is no anonymous pull.

Access is read-only for everyone outside the owning team: no pushes, no deletes, no tag changes.

## Sandbox-specific behavior

Verified against the [images docs](https://vercel.com/docs/sandbox/concepts/images) (2026-08-10):

- Sandbox runs `linux/amd64` images only. VCR prepares an optimized amd64 build after each push; `Sandbox.create()` returns `image_not_ready` until the repository shows **Ready**.
- Docker `ENTRYPOINT`/`CMD` are **not** executed. Start OpenClaw explicitly, e.g. `sandbox.runCommand({ cmd: 'openclaw', args: ['gateway', 'run', '--auth', 'token', '--port', '18789'], env: { OPENCLAW_GATEWAY_TOKEN: token }, detached: true })` (see `host/lib/wake.ts`). The port matters: `openclaw agent` accepts no address or credential flag, so it always dials `127.0.0.1:18789`, and a gateway anywhere else is invisible to it.
- `WORKDIR` is honored; otherwise commands start in `/`.
- Persistence works with custom images: sandboxes snapshot on stop (including server-side timeout) and resume with the filesystem intact.

## Roadmap

This repo replaces the archived `vercel-openclaw` template and its bundle supply chain. The suspension control plane (upstream [#103618](https://github.com/openclaw/openclaw/pull/103618), first released in the 2026.7.2 beta line, reaching stable in 2026.8.1) is implemented in `host/`; next up is live end-to-end validation against 2026.8.1 stable, resolving the open contract questions in [`docs/suspension-spec.md`](docs/suspension-spec.md), and cron-aware wake.

## License

MIT
