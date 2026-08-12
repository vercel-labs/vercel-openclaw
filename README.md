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

> **Status:** the image is published to the OpenClaw Foundation's VCR repository ([vercel.com/openclaw-foundation/openclaw/images/openclaw](https://vercel.com/openclaw-foundation/openclaw/images/openclaw)) and flips public shortly. The reference above is final.

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

- `app/api/webhook/[channel]/route.ts` — webhooks terminate here (a sleeping VM is unreachable). Stamps the idle clock, wakes the sandbox, forwards the untouched raw bytes and original headers (signatures verify over both) to the gateway's native handler.
- `app/api/cron/idle-check/route.ts` — the scheduler ([`vercel.json`](host/vercel.json), every 5 min): 60 minutes without host-visible activity triggers the suspend attempt.
- `lib/wake.ts` — `ensureAwake()`: resume or create the sandbox, restart the gateway (`onResume` — processes don't survive stops, only disk does), health-check via `openclaw gateway call health`, return the exposed-port URL.
- `lib/suspend.ts` — the verified `gateway.suspend.*` contract (2026.7.2-beta.7): prepare as idle-fence, 2-minute lease, busy/ready/conflict/recovering handling, ceiling force-stop.
- `lib/activity.ts` + tests — the idle clock: which events reset it, 60-minute threshold, extend-timeout rules.

It's a headless API-only Next.js app. Deploy with the Vercel project's **Root Directory set to `host`** — `vercel.json` (the cron schedule) lives there, and without it the idle path silently never runs. Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token; the host holds it, the gateway enforces it |
| `SLACK_SIGNING_SECRET` | Verifies Slack webhooks at the host, before any compute wakes (fail-closed) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis-backed activity store (Upstash REST protocol; `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` also accepted). **Required in production**: without it the idle clock is per-instance memory and the idle path never fires |
| `OPENCLAW_SANDBOX_NAME` | Sandbox name (default `openclaw`) |
| `OPENCLAW_IMAGE` | Image override (default `openclaw-foundation/openclaw/openclaw:latest`) |
| `GATEWAY_URL` | Dev-only: skip the wake path, forward to a directly reachable gateway |
| `CRON_SECRET` | Protects the cron route when set |

Known v1 limitations, deliberate until the PoC with the OpenClaw team: the webhook response blocks on cold wakes (Slack's 3s ack window needs an ack-then-forward pattern), and the deployment assumes a Pro or Enterprise team (the 75-minute session timeout, `maxDuration: 300`, and the 5-minute cron all exceed Hobby limits).

**Live-validated** against `2026.7.2-beta.7`: two full sleep/wake cycles through this code path — gateway boot, health, `prepare` → `ready` → stop → snapshot → resume → gateway restart (`host/scripts/e2e-lifecycle.ts`). End-to-end wake is **~10s** (cold and from snapshot alike); the sandbox's own resume including snapshot restore is sub-second, and ~7s of the total is the OpenClaw gateway booting. The runs also confirmed interrupted work auto-continues after an abrupt stop, and surfaced one upstream issue with held leases (spec, contract question 6). Re-validation against 2026.7.2 stable when it ships.

## How the image stays current

The VCR repository belongs to the OpenClaw Foundation, so keeping it current is theirs to run. This repo provides both mechanisms ready-made:

1. **Target state:** OpenClaw's release CI pushes to VCR directly, the same way it already publishes to ghcr.io and Docker Hub. The ready-to-adopt patch lives in [`docs/upstream-ci.md`](docs/upstream-ci.md).

2. **Until then:** [`mirror-image.yml`](.github/workflows/mirror-image.yml) is a drop-in scheduled workflow that copies the `latest` and `slim` tags from `ghcr.io/openclaw/openclaw` to VCR — digest-checked, idempotent, betas excluded by construction (upstream's release pipeline never promotes betas to the moving tags it tracks). Adopt it in any repo with two secrets (`VERCEL_VCR_TOKEN` scoped to the owning team, `VERCEL_TEAM_ID`).

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

This repo replaces the archived `vercel-openclaw` template and its bundle supply chain. The suspension control plane (upstream [#103618](https://github.com/openclaw/openclaw/pull/103618), shipping in the 2026.7.2 line) is implemented in `host/`; next up is live end-to-end validation against 2026.7.2 stable, resolving the open contract questions in [`docs/suspension-spec.md`](docs/suspension-spec.md), a durable activity store, and cron-aware wake.

## License

MIT
