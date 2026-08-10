# vercel-openclaw

Run [OpenClaw](https://github.com/openclaw/openclaw) in [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

OpenClaw's official Docker image is mirrored into [Vercel Container Registry](https://vercel.com/docs/container-registry) (VCR) as a public repository. Any Vercel account can boot it as a sandbox with one call:

```ts
import { Sandbox } from '@vercel/sandbox';

const sandbox = await Sandbox.create({
  image: 'vercel/openclaw/openclaw:latest',
});
```

No Dockerfile, no build step, no bundle pipeline. The image is the same one OpenClaw publishes to `ghcr.io/openclaw/openclaw` (stable channel, `linux/amd64`).

> **Status:** the VCR repository is being provisioned. The image reference above is final once it flips public; until then, see [Mirroring](#mirroring) for how the image gets there.

## Quickstart

```bash
cd examples
npm install
vercel link          # any project; the SDK reads its OIDC token
vercel env pull
npm run boot         # boots the image, prints `openclaw --version`
```

`examples/boot.ts` is the smallest end-to-end proof: create a sandbox from the image, run `openclaw --version`, stop.

## How the image stays current

Two mechanisms, one active at a time:

1. **Interim (this repo):** [`mirror-image.yml`](.github/workflows/mirror-image.yml) runs daily and copies the `latest` and `slim` tags from `ghcr.io/openclaw/openclaw` to VCR. Copies are digest-checked and skipped when VCR is already current. Betas are excluded by construction: OpenClaw's release pipeline only promotes stable releases to the moving tags this mirror tracks.

2. **Target state:** OpenClaw's release CI pushes to VCR directly, the same way it already publishes to ghcr.io and Docker Hub. The ready-to-adopt patch lives in [`docs/upstream-ci.md`](docs/upstream-ci.md). Once that lands, the mirror retires (cron removed, manual dispatch kept as backstop).

## What "public" means

Public VCR repositories are readable by **any Vercel account** ([changelog](https://vercel.com/changelog/vercel-container-registry-repositories-can-now-be-made-public)). Pulls are authenticated: `Sandbox.create()` works from any team, and `docker pull vcr.vercel.com/...` works after `vercel vcr login`. There is no anonymous pull.

Access is read-only for everyone outside the owning team: no pushes, no deletes, no tag changes.

## Sandbox-specific behavior

Verified against the [images docs](https://vercel.com/docs/sandbox/concepts/images) (2026-08-10):

- Sandbox runs `linux/amd64` images only. VCR prepares an optimized amd64 build after each push; `Sandbox.create()` returns `image_not_ready` until the repository shows **Ready**.
- Docker `ENTRYPOINT`/`CMD` are **not** executed. Start OpenClaw explicitly, e.g. `sandbox.runCommand('openclaw', ['gateway', '--port', '3000', '--bind', 'loopback'])`.
- `WORKDIR` is honored; otherwise commands start in `/`.
- Persistence works with custom images: sandboxes snapshot on stop (including server-side timeout) and resume with the filesystem intact.

## Roadmap

This repo replaces the archived `vercel-openclaw` template and its bundle supply chain. Next up: a control plane wired to OpenClaw's gateway suspension handshake (upstream [#103618](https://github.com/openclaw/openclaw/pull/103618), shipping in the 2026.7.2 line) so sandboxes sleep between messages and wake on demand.

## License

MIT
