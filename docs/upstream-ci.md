# Adding Vercel Container Registry to OpenClaw's release CI

A ready-to-adopt patch for `openclaw/openclaw`'s `.github/workflows/docker-release.yml`. The workflow already publishes every release to two registries (ghcr.io and Docker Hub) from the same build; VCR is a mechanical third entry. Four touch points, no changes to the build itself.

Written against `docker-release.yml` on `main` as of 2026-08-10. VCR facts below are from [vercel.com/docs/container-registry](https://vercel.com/docs/container-registry) (retrieved 2026-08-10).

## What Vercel provides

- A VCR repository: `vcr.vercel.com/vercel/openclaw/openclaw`, public (any Vercel account can pull; read-only for everyone but the owning team).
- Two secrets for this repo's CI:
  - `VERCEL_VCR_TOKEN` — a Vercel access token scoped to the owning project. Rotation owner: Elisabeth Rülke (Vercel).
  - `VERCEL_TEAM_ID` — the owning team's ID; VCR uses it as the docker login username.

Auth is standard `docker login`:

```bash
printf '%s' "$VERCEL_VCR_TOKEN" | docker login vcr.vercel.com \
  --username "$VERCEL_TEAM_ID" --password-stdin
```

## The patch (4 touch points)

Every VCR step is guarded so runs without the secrets (forks, secretless backfills) stay green.

### 1. `env` block

```yaml
env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}
  DOCKERHUB_REGISTRY: docker.io
  DOCKERHUB_IMAGE_NAME: openclaw/openclaw
  # add:
  VCR_REGISTRY: vcr.vercel.com
  VCR_IMAGE_NAME: vercel/openclaw/openclaw
```

### 2. Login step (4 jobs: `build-amd64`, `build-arm64`, `create-manifest`, `verify-attestations`)

Mirror the existing Docker Hub login block, same pinned action:

```yaml
      - name: Login to Vercel Container Registry
        if: ${{ env.VCR_ENABLED == 'true' }}
        uses: docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0 # v4.4.0
        with:
          registry: ${{ env.VCR_REGISTRY }}
          username: ${{ secrets.VERCEL_TEAM_ID }}
          password: ${{ secrets.VERCEL_VCR_TOKEN }}
```

with a small resolver step (secrets aren't directly usable in `if:`):

```yaml
      - name: Resolve VCR availability
        run: echo "VCR_ENABLED=${{ secrets.VERCEL_VCR_TOKEN != '' }}" >> "$GITHUB_ENV"
```

### 3. Image refs in the tag resolvers and manifest job

In both per-arch "Resolve image tags" steps, extend the fan-out array:

```bash
images=("${GHCR_IMAGE}" "${DOCKERHUB_IMAGE}")
if [[ "${VCR_ENABLED}" == "true" ]]; then
  images+=("${VCR_REGISTRY}/${VCR_IMAGE_NAME}")
fi
```

In `create-manifest`, add a VCR `create_manifest` call following the Docker Hub pattern (per-arch tags rebuilt within the same registry, not cross-registry digests):

```bash
create_manifest "${VCR_IMAGE}:${version}-amd64" "${VCR_IMAGE}:${version}-arm64" "${vcr_tags[@]}"
```

Pushing the same per-arch + manifest-list structure you use for the other registries is fine: VCR supports OCI image indexes and Docker manifest lists, and serves Sandbox from an optimized `linux/amd64` build it prepares after push. If you'd rather halve the storage, pushing only the amd64 image also works — Sandbox never uses arm64.

### 4. Channel promotion + secrets threading

Add VCR to the alias promotion (beta-skip comes free — the step already skips the beta channel):

```yaml
          node scripts/docker-channel-promote.mjs \
            --version "${VERSION}" \
            --image "${GHCR_IMAGE}" \
            --image "${DOCKERHUB_IMAGE}" \
            --image "${VCR_IMAGE}"
```

And thread the secrets through the caller (`openclaw-release-publish.yml`), declared `required: false` so existing invocations keep working:

```yaml
    secrets:
      DOCKERHUB_USERNAME: {required: true}
      DOCKERHUB_TOKEN:    {required: true}
      VERCEL_VCR_TOKEN:   {required: false}
      VERCEL_TEAM_ID:     {required: false}
```

Same `--image` addition in the standalone `docker-channel-promote.yml` re-promoter.

## Explicit recommendation: keep VCR out of `verify-attestations`

`scripts/verify-docker-attestations.mjs` currently verifies SBOM/provenance on both registries' refs. VCR's attestation support is undocumented; leave VCR off that list initially rather than gating releases on it. The image content is digest-identical to what ghcr verification already covers.

## Limits worth knowing

From [VCR limits & pricing](https://vercel.com/docs/container-registry/limits-and-pricing) (retrieved 2026-08-10): 500 MB max per compressed layer, 15 GB max total image size, gzip or zstd layer compression (zstd recommended). Current OpenClaw images are comfortably inside all three.

## Rollout

1. Vercel adds the two secrets to `openclaw/openclaw` (or hands them to a maintainer to add).
2. This patch lands; the next stable release publishes to three registries.
3. Vercel retires its interim daily mirror (this repo's `mirror-image.yml` cron) and keeps manual dispatch as a backstop.
