# Vercel worker provider and Codex PoC

Restricted Playground prototype. See [the current Slack sleep/wake setup and validation status](../host/CODEX-POC.md). Not ready for production.

This provider accepts OpenClaw's native `worker-turn` and `remote-exec` provisioning modes. The approved Codex PoC uses two Vercel Sandboxes: the OpenClaw gateway and Codex engine in VM1, with Codex's exec-server and generated commands in VM2. Project files can return to VM1 as data; they must not run as gateway software or change its guardrails. The image-based native Slack two-turn test passed, including Connect delivery, code execution, matching saved-file hashes across sleep/wake, eyes reactions and stopped VMs.

The separate `worker-turn` experiment and runner remain available. Both modes use OpenClaw's authenticated node transport. The provider adds no custom WebSocket protocol, Crabbox dependency, or Workflow dependency. The host uses Vercel Connect for Slack event forwarding and credentials; the host owns wake and sleep.

The compatibility target is OpenClaw `2026.9.2` (build `3928bad9badfcb6c7d140530435e806fb8092190`) with [the local adapter patches](patches/README.md), Codex `0.153.4`, and `@vercel/sandbox` `3.2.1`. The published OpenClaw base image is digest-pinned and prepared once into a runtime snapshot. OpenClaw's plugin APIs are experimental; these pins do not establish compatibility with another release.

## Implemented scope

- A worker-provider manifest and registration entrypoint, advertising `worker-turn` and `remote-exec`. Mode selection, enrollment, firewall lockdown and failure cleanup have local regression coverage.
- A gateway-local SQLite allocation journal, separate from OpenClaw's schema. Allocation intent is saved before the create request. A lost response can be recovered by the exact sandbox name; it never triggers another create request. Retired operation ids remain retired even after Vercel removes an old sandbox record. The journal rejects new entries at 10,000 rather than evicting ownership records.
- Non-persistent workers with no exposed ports and a 20–60-minute hard lifetime. OpenClaw owns workspace reconciliation; this prototype does not snapshot worker identities or background processes.
- Image startup verifies the preinstalled native artifact against the gateway's byte length and SHA-256. It does not install dependencies per turn. The source-install experiment retains its separate verified bootstrap path.
- Image workers have gateway-only egress from startup. Source-install workers temporarily allow the configured registry, then remove it before enrollment completes. Host headers are pinned by firewall transformations. General browsing and package installation during a turn are not enabled.
- Ownership checks before guest commands and cleanup. Inspection and cleanup do not request resume. An inaccessible or missing previously requested allocation remains unresolved; a 404 is not treated as proof of cleanup.

The Sandbox administration token lives only in the trusted gateway process. It must never be added to the worker environment. The gateway and its allocation journal must not share a writable drive with the worker. Preserve the journal with gateway backups and snapshots; restoring OpenClaw state without its corresponding allocation journal is unsupported.

OpenClaw itself can supply a per-turn GitHub token in `worker-turn` mode. This provider does not remove that behavior. GitHub permissions and gateway-executed callback tools still need an explicit guardrail review before enabling customer accounts.

## Provider configuration

Build and install the plugin only into an isolated gateway with the exact pinned host version. Keep the gateway-only `VERCEL_TOKEN` or `VERCEL_OIDC_TOKEN` in the controller's secret environment. Lifecycle calls use the explicit project and team in the frozen profile. Token refresh is not implemented here.

```json
{
  "plugins": {
    "allow": ["vercel-worker"],
    "entries": { "vercel-worker": { "enabled": true } }
  },
  "cloudWorkers": {
    "profiles": {
      "vercel": {
        "provider": "vercel-worker",
        "suspendAfter": "10m",
        "settings": {
          "gatewayOrigin": "https://gateway.example.org",
          "projectId": "prj_example",
          "teamId": "team_example",
          "timeoutMs": 2700000
        }
      }
    }
  }
}
```

Merge the plugin entries into existing configuration; do not replace an existing allowlist with this example. The public gateway must forward native node/worker WebSockets and `/__openclaw__/worker-bootstrap/artifacts/<sha256>`, preserving authorization. The prototype accepts public CA certificates only, not a custom TLS fingerprint.

## Verification

```sh
npm ci
npm run typecheck
npm run build
npm test
```

The dependency-free journal and archive checks can also run on Node 26 without installing OpenClaw:

```sh
npm run test:core
```

The September 10 native Slack tests passed through Connect, with independent file persistence and stopped-VM checks. Later reply observations ranged from 60.2 to 98.1 seconds despite preinstallation; no consistent end-to-end speedup has been demonstrated. See [the host guide](../host/CODEX-POC.md#validation-and-limitations) for the pinned runtime, current native test and remaining limits. The earlier local baseline passed 117 provider tests and 176 host tests before the handoff-test additions.

Independent read-only review found late native-policy validation and a false failure reply after native delivery when host stop failed. Both were fixed and regression-tested; follow-up review reported zero P0, P1 or P2 findings. A live temporarily disallowed-user test left VM1 stopped without a bot reply. The normal policy was restored before the final two-turn test. The reviewer did not independently rerun the live evidence. This is a working scoped PoC, not a production-readiness or adversarial-security certification.

Installation completed with approved exceptions for exactly `openclaw@2026.9.2` and `@openclaw/ai@2026.9.2`, through the configured security registry with other dependencies retaining the two-day policy. Both published archives and locked integrities match. All 422 lock entries passed authenticated online age and integrity verification. npm's documented lockfile format without `resolved` URLs is supported and regression-tested. No global npm setting was changed.

## Historical worker-turn experiment

The following runner and checkpoints describe the separate `worker-turn` experiment, not the deployed Codex/native-Slack path. Use [the host guide](../host/CODEX-POC.md) for that path's current evidence and limitations.

`test/e2e/run.mjs` implements the session driver. Its test-only ingress relay probes an admitted worker connection for one exact session/run, confirms live ownership, attempts one forbidden `config.patch`, and requires the exact rejection and gateway-initiated close. This proof is mandatory for both pass signals. It does not modify the OpenClaw bundle or add a production transport.

September 7 live checkpoint: three runs, four VMs, all confirmed stopped. The first two exposed the test-client pairing requirement; exact read-only operator approval fixed it. The third reached active native worker placement with a connected tunnel, then failed because the harness read the default sandbox policy rather than the session policy. A read-only check of the stopped worker's `currentSession().networkPolicy` matched the complete intended Host-transformation rules. The dispatch assertion still needs that getter correction and a regression before the next live run. No agent turn or full guardrail/lifecycle cycle completed, and the live-model smoke has not run.

The runner uses a disposable trusted gateway Sandbox and a worker provisioned by this plugin. Its deterministic model endpoint requests an actual native `exec` call. It checks worker-only random input, remote file output, matching accepted gateway worktree bytes and the transcript. It also contains worker-loss, explicit replacement, cancellation and native-reclaim scenarios. No complete passing native run has been observed yet.

Run from this directory with Node 26 and npm that supports `min-release-age` and `min-release-age-exclude`:

```sh
npm install --ignore-scripts
node node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs
npm run typecheck
npm run build
npm test

export OPENCLAW_E2E_RUN=1
export VERCEL_PROJECT_ID=prj_YOUR_TEST_PROJECT
export VERCEL_TEAM_ID=team_YOUR_TEST_TEAM
export OPENCLAW_E2E_PROJECT_NAME=your-test-project
export OPENCLAW_E2E_OIDC_FILE=/absolute/path/to/private-test.env
export OPENCLAW_E2E_RESULTS_DIR=/absolute/path/to/new-native-results
unset VERCEL_TOKEN

npm run test:e2e:preflight
npm run test:e2e:live
```

Obtain a fresh OIDC token for the existing disposable-test project. The optional OIDC file reader imports only `VERCEL_OIDC_TOKEN`; it does not forward other secrets from the file. The token must match the explicit project id, team id and project name and outlive the test timeout. Do not use customer or production credentials. Preflight is read-only and never allocates a VM.

The selected npm registry is carried into gateway and worker installs. Every locked registry dependency is checked against its published integrity and release timestamp before allocation. Keep the two-day minimum, or a stricter local policy. `OPENCLAW_E2E_NPM_EXCEPTIONS` accepts only explicitly approved package names (`openclaw`, `@openclaw/ai`), constrained to version `2026.9.2`; it defaults to empty. Any corresponding local npm install exception also needs explicit approval. Neither a wildcard nor disabling the age policy is supported. Guest npm fails closed if it cannot enforce these options.

For an authenticated registry, the runner reads only its exact npm credential scope. Metadata requests cannot redirect or leave that scope. Guest installs receive authorization through firewall header injection, not process environment. The provider requires `OPENCLAW_NPM_AUTH_REGISTRY` alongside gateway-only `OPENCLAW_NPM_AUTHORIZATION` and rejects a different profile registry. Registry access is removed before the worker is returned.

The separate model smoke requires a passing deterministic receipt for the same build and test project:

```sh
export OPENCLAW_E2E_NATIVE_RECEIPT=/absolute/path/to/new-native-results/receipt.json
export OPENCLAW_E2E_RESULTS_DIR=/absolute/path/to/new-model-results
export OPENCLAW_E2E_MODEL=provider/model-from-current-inventory
# Supply the existing AI_GATEWAY_API_KEY through your secret environment.
npm run test:e2e:model
```

Model smoke checks the selected id against the authenticated AI Gateway inventory. A gateway-local proxy limits it to 4 calls, 65,536 request bytes per call and 1,024 output tokens per call. The API key is supplied to that proxy only after the public gateway authentication check. These bounds limit exposure; they are not a dollar-cost guarantee.

The controller permits at most 2 concurrent VMs and 3 total allocations for the deterministic run (gateway plus 2 sequential workers), with a 45-minute hard VM lifetime and no extension. Model smoke runs separately with one gateway and one worker. Resources are non-persistent. The controller records allocation intent before creation, recovers worker handles from the gateway journal and tags, and confirms stopped state with `resume: false`. Cleanup tries every owned worker before stopping the gateway VM. An inaccessible resource or a 404 leaves cleanup unresolved and the run failed. A killed controller may need manual cleanup of the exact recorded handles; the VM timeouts remain the fallback.

Results are private, redacted and saved only in the explicit fresh output directory (`results/` is ignored in this package). `NATIVE_WORKER_E2E_PASS` requires every lifecycle and guardrail assertion plus confirmed cleanup. `NATIVE_MODEL_SMOKE_PASS` is separate. Neither signal has been observed.

Required next proof:

1. Load this plugin in the pinned gateway and validate the profile.
2. Provision a disposable Vercel worker, install the native artifact, enroll, and dispatch a managed-worktree session.
3. Observe an actual native turn execute and edit a file on the worker, reconcile it back, and demonstrate that gateway-only files and the Vercel token are unavailable there.
4. Verify the TLS/WebSocket path under the restrictive firewall and a denied external request. Model output is not proof of execution location.
5. Test worker loss and denied execution without gateway-local fallback; test interruption, cancellation, ambiguous creation, cleanup failure, and plugin shutdown.
6. Connect worker reconciliation to the existing gateway suspension handshake before testing gateway sleep/wake. Do not assume `prepare → ready` alone accounts for every worker process.

The worker-turn experiment above remains unverified. The separate Codex `remote-exec` path now has AI Gateway and native Slack sleep/wake proof. Durable webhook retries, proactive wake, OAuth-expiry testing, private TLS pins and production recovery remain outside the verified scope. A bootstrap failure stops the worker and requires a new placement; transparent replay of interrupted setup is not claimed. An ambiguous create with no visible matching sandbox remains fenced and requires investigation.

## Sources

- [OpenClaw worker-provider SDK](https://github.com/openclaw/openclaw/blob/270762e51d6559dfb4ede3f9fd5d8d1aaa342ac4/docs/plugins/sdk-overview.md), [provider types](https://github.com/openclaw/openclaw/blob/270762e51d6559dfb4ede3f9fd5d8d1aaa342ac4/src/plugins/capability-provider.types.ts), and [reference enrollment](https://github.com/openclaw/openclaw/blob/270762e51d6559dfb4ede3f9fd5d8d1aaa342ac4/extensions/crabbox/src/crabbox-worker-node-enrollment.ts), inspected September 6, 2026. The published `2026.9.2` package's types and docs were also inspected.
- [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference), [firewall](https://vercel.com/docs/sandbox/concepts/firewall), and [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), retrieved September 6, 2026.
- [Node SQLite API](https://github.com/nodejs/node/blob/v26.7.0/doc/api/sqlite.md).
- [Crabbox Vercel backend](https://github.com/openclaw/crabbox/blob/b3990816fed0bd3595ff2401b809149c7a064cb9/internal/providers/vercelsandbox/provider.go). The credential-free Crabbox `v0.50.0` CLI probe returned exit 2: `provider=vercel-sandbox does not support fixed idempotent lease IDs`. This is why the prototype uses a direct provider.
