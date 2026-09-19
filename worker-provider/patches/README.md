# Local OpenClaw adapter patch

Apply `openclaw-vercel-ai-gateway.patch` to OpenClaw commit
`3928bad9badfcb6c7d140530435e806fb8092190` (2026.9.2). It contains the
prototype's Vercel Codex route, credential handoff and reviewer changes,
including early credential selection, core route/auth preparation, and Node
certificate-trust propagation on the execution worker. It is
not an upstream PR. Also apply `openclaw-channel-ingress-scope.patch` for
native Slack. It binds durable delivery to the queue owner's gateway scope,
preserving the public webhook's empty scopes and the claim's cancellation
and shutdown lifecycle. It does not modify the official Slack package or
grant additional RPC permissions.

From the PoC repository root, create a separate clean upstream checkout:

```sh
export POC_ROOT="$PWD"
git clone https://github.com/openclaw/openclaw.git ../openclaw-poc-source
cd ../openclaw-poc-source
git checkout --detach 3928bad9badfcb6c7d140530435e806fb8092190
pnpm install --frozen-lockfile
```

The upstream packageManager pins pnpm 12.1.0. Use Node 26. Preserve upstream
dependency trust settings and your configured registry policy. Then apply and test:

```sh
git apply --check "$POC_ROOT/worker-provider/patches/openclaw-vercel-ai-gateway.patch"
git apply --index "$POC_ROOT/worker-provider/patches/openclaw-vercel-ai-gateway.patch"
git apply --check "$POC_ROOT/worker-provider/patches/openclaw-channel-ingress-scope.patch"
git apply --index "$POC_ROOT/worker-provider/patches/openclaw-channel-ingress-scope.patch"
node scripts/run-vitest.mjs src/channels/message/ingress-monitor.test.ts src/channels/message/ingress-monitor.admission.test.ts src/channels/message/ingress-monitor.restart-drain.test.ts extensions/slack/src/monitor/ingress.test.ts
node scripts/run-vitest.mjs extensions/codex/harness.test.ts extensions/codex/src/app-server/vercel-auth.test.ts extensions/codex/src/app-server/auth-bridge.test.ts extensions/codex/src/app-server/app-server-policy.test.ts extensions/vercel-ai-gateway/provider-policy-api.test.ts
node scripts/run-vitest.mjs extensions/codex/src/app-server/bounded-turn.test.ts extensions/codex/src/app-server/shared-client.test.ts extensions/codex/src/app-server/thread-lifecycle.test.ts
node scripts/run-vitest.mjs src/agents/runtime-plan/prepare-auth.vercel.test.ts src/agents/runtime-plan/auth.test.ts src/agents/runtime-plan/prepare-auth.test.ts src/agents/runtime-plan/prepare-auth.ambient-credential.test.ts src/agents/runtime-plan/prepare-auth.setup-provider.test.ts src/agents/runtime-plan/resolve-auth.test.ts src/agents/runtime-plan/build.test.ts
node scripts/run-vitest.mjs extensions/codex/src/node-exec-server.test.ts extensions/codex/src/app-server/transport-stdio.test.ts extensions/codex/src/app-server/transport-stdio.config.test.ts
node scripts/package-openclaw-for-docker.mjs --pnpm-pack --bundle-plugin codex --bundle-plugin vercel-ai-gateway --output-dir .artifacts/vercel-codex-poc --output-name openclaw-poc.tgz
```

Use `--index`: upstream discovers standalone plugin build entries from Git's
tracked files. Applying without it leaves the new policy entry untracked, so
the package builder omits it even though source tests pass.

The canonical package command invokes the upstream build itself; do not pass
`--skip-build` on a clean checkout. It writes the archive to
`.artifacts/vercel-codex-poc/openclaw-poc.tgz`. Return to
`$POC_ROOT` and continue with [the native Slack hosting guide](../../host/CODEX-POC.md).

Keep dependency signature and release-age checks enabled. Generate a new
installation record for the resulting archive using the test runner's
`prepare-install` command. Do not reuse an older archive digest or installation
record. Source-build output can differ between builds.

See `../CODEX-REVIEW.md` for the observed test result and limitations. The
architecture remains OpenClaw + Codex in VM1, generated code execution in VM2.
