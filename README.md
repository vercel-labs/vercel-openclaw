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

- `app/api/webhook/[channel]/route.ts` — webhooks terminate here (a sleeping VM is unreachable). Verifies Slack and acknowledges inside its three-second window, then stamps the idle clock, wakes the sandbox, and forwards the untouched raw bytes and original headers to the gateway's native handler in the background.
- `app/api/cron/idle-check/route.ts` — the scheduler ([`vercel.json`](host/vercel.json), every 5 min): 60 minutes without host-visible activity triggers the suspend attempt.
- `lib/wake.ts` — `ensureAwake()`: resume or create the sandbox, install/configure the Slack and Vercel AI Gateway providers, restart the gateway (`onResume` — processes don't survive stops, only disk does), health-check via `openclaw gateway call health`, return the exposed-port URL.
- `lib/suspend.ts` — the verified `gateway.suspend.*` contract (2026.7.2-beta.7): prepare as idle-fence, 2-minute lease, busy/ready/conflict/recovering handling, ceiling force-stop.
- `lib/activity.ts` + tests — the idle clock: which events reset it, 60-minute threshold, extend-timeout rules.

It's a headless API-only Next.js app. Deploy with the Vercel project's **Root Directory set to `host`** — `vercel.json` (the cron schedule) lives there, and without it the idle path silently never runs. Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token; the host holds it, the gateway enforces it |
| `SLACK_SIGNING_SECRET` | Verifies Slack webhooks at the host, before any compute wakes (fail-closed) |
| `SLACK_BOT_TOKEN` | Slack bot token used by OpenClaw to read context and post replies |
| `AI_GATEWAY_API_KEY` | Optional explicit Vercel AI Gateway key. On Vercel, the host passes the request-scoped OIDC token supplied in `x-vercel-oidc-token` to the sandbox when this is absent |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis-backed activity store (Upstash REST protocol; `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` also accepted). **Required in production**: without it the idle clock is per-instance memory and the idle path never fires |
| `OPENCLAW_SANDBOX_NAME` | Sandbox name (default `openclaw`) |
| `OPENCLAW_IMAGE` | Image override (default `openclaw-foundation/openclaw/openclaw:latest`) |
| `GATEWAY_URL` | Dev-only: skip the wake path, forward to a directly reachable gateway |
| `CRON_SECRET` | Protects the cron route when set |

For a direct Slack app, point Event Subscriptions, Interactivity, and the optional `/openclaw` slash command at `/api/webhook/slack` on the production domain. Add the `reactions:write` bot scope and reinstall the app if you want the host to acknowledge each message with an eyes reaction before waking OpenClaw. Slack Incoming Webhooks are not used and can remain disabled. The deployment assumes a Pro or Enterprise team because the 75-minute session timeout, `maxDuration: 300`, and the 5-minute cron exceed Hobby limits.

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
- Docker `ENTRYPOINT`/`CMD` are **not** executed. Start OpenClaw explicitly, e.g. `sandbox.runCommand({ cmd: 'openclaw', args: ['gateway', 'run', '--auth', 'token', '--port', '3000'], env: { OPENCLAW_GATEWAY_TOKEN: token }, detached: true })` (see `host/lib/wake.ts`).
- `WORKDIR` is honored; otherwise commands start in `/`.
- Persistence works with custom images: sandboxes snapshot on stop (including server-side timeout) and resume with the filesystem intact.

## Roadmap

This repo replaces the archived `vercel-openclaw` template and its bundle supply chain. The suspension control plane (upstream [#103618](https://github.com/openclaw/openclaw/pull/103618), first released in the 2026.7.2 beta line, reaching stable in 2026.8.1) is implemented in `host/`; next up is live end-to-end validation against 2026.8.1 stable, resolving the open contract questions in [`docs/suspension-spec.md`](docs/suspension-spec.md), a durable activity store, and cron-aware wake.

## License

MIT
