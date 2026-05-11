# Release And Reliability

Release work crosses the OpenClaw fork, this dashboard, and the `vclaw` CLI, so each artifact needs its own verification proof.

## OpenClaw Bundle Release

The OpenClaw fork publishes sandbox bundle assets through its Sandbox Bundle Assets workflow. A compatible release must include the full sidecar set expected by `vclaw` and dashboard bootstrap.

Required bundle assets currently include:

- `openclaw.bundle.mjs`
- `channel-catalog.json`
- `workspace-templates.tar.gz`
- `channels.tar.gz`
- `bundle-deps.tar.gz`
- `bundle-openclaw-pkg.tar.gz`
- `channel-shared-chunks.tar.gz`
- `control-ui.tar.gz`

The important compatibility risk is asset shape drift. A release with only `openclaw.bundle.mjs` is not enough, and a bundle can build successfully while still failing dashboard restore or channel route readiness.

During migration, dashboard bootstrap treats a missing `asset-manifest.json` as a legacy-bundle warning, but a present malformed or incompatible manifest is fatal. That failure uses `OPENCLAW_BUNDLE_COMPATIBILITY_MISMATCH` and happens before sandbox downloads begin.

## Dashboard Release

Dashboard changes land in this repository. The canonical CI entrypoint is:

```bash
node scripts/verify.mjs
```

For docs or env-contract changes, also run:

```bash
pnpm check:verify-contract
```

For live operational fixes, verify with runtime surfaces as well as tests: `/api/admin/why-not-ready`, `/api/channels/summary`, `/api/admin/sandbox-diag`, `/api/admin/logs`, and a real channel or launch-verify path when relevant.

## CLI Publish

`@vercel/vclaw` publishes through GitHub trusted publishing. Before release work, audit the package surface from the `vclaw` repository:

```bash
npm pack --dry-run --json
```

The workflow should check tag/version agreement, run tests, and publish with npm provenance. Treat the package allowlist as part of the release contract because `vclaw` is a user-facing global CLI.

## Cross-Repo Compatibility Gates

- `vclaw` bundle resolver finds a GitHub Release with the complete asset set.
- Dashboard bootstrap understands the bundle asset layout.
- `OPENCLAW_BUNDLE_URL` points at the intended release asset when pinning.
- Channel route readiness is tested after OpenClaw plugin/channel runtime changes.
- Documentation does not treat passing CI as proof of live webhook delivery.

## Known Risk Areas

- Deployment Protection can block webhooks before dashboard auth runs.
- Redis env vars can exist before an integration secret is usable at runtime.
- Persistent sandboxes preserve filesystem state across code changes, so old sandboxes may need reset or restore-script regeneration.
- AI Gateway auth depends on Vercel OIDC in deployed environments; tokens should be injected through network policy transforms, not written into sandbox config.
- Channel delivery has layered states; connected, delivery-ready, route-ready, accepted, and user-visible are not interchangeable.
