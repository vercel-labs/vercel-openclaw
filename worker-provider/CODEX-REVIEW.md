# Codex PoC review

Historical basic-coding review from September 9, 2026. This snapshot predates the deployed Connect/native-Slack work. See [the current hosting guide](../host/CODEX-POC.md) for setup, live validation status, and limitations.

## Placement

Two Vercel Sandboxes:

- VM1 runs the OpenClaw gateway and Codex app-server, with the AI Gateway credential and Sandbox administration.
- VM2 runs native Codex exec-server, generated commands, and the project workspace.

Reconciled project files return to VM1 as data. Passing project tests does not authorize installing or executing them as gateway software. The earlier native-worker experiment remains separate.

## Historical basic-coding result

The basic PoC passes end to end. The September 9 run passed all eight acceptance checks in one Codex turn through AI Gateway, followed by the standalone saved-result verifier. Exactly two VMs were created; both were independently confirmed stopped.

Codex repaired the invoice function and ran the project tests in VM2. Eight independently generated cases passed. The worker-only marker reached the assistant reply, `session_status` returned through OpenClaw, and the invoice plus helper report reconciled byte-for-byte to VM1. Native reclaim and allocation-journal recovery passed.

Observed completion markers: `CODEX_SMOKE_PASS` and `CODEX_SMOKE_RECEIPT_PASS`. The run took 199 seconds including setup and cleanup. This proves the basic coding flow, not full OpenClaw hosting or a complete security audit.

The earlier missing report was traced to `SELF_SIGNED_CERT_IN_CHAIN`: the worker's strict environment filter dropped Node's certificate-trust settings. Preserving the two documented Node CA settings fixed the HTTPS helper. TLS verification remains enabled.

## Repairs implemented

- Preserve the selected provider's route and credential owner through OpenClaw's early selection and final auth preparation.
- Admit the unused ChatGPT URL default materialized by native Codex, while retaining the explicit Vercel endpoint, credential, catalog, and override checks.
- Keep one signed, approval-capable test-controller connection. It has approval/read/write scopes, no admin scope, and can send one exact run-and-placement-bound `allow-once` decision per turn.
- Preserve worker-host `NODE_EXTRA_CA_CERTS` and `NODE_USE_SYSTEM_CA` through native exec-server startup. Credentials and runtime-injection variables remain excluded.
- Preserve explicit `exec`, `process`, `gateway`, and `openclaw` dynamic-tool exclusions even when the discovered catalog omits a name. Keep `session_status` available.
- Verify saved results against the original validated installation lock. The removed text-log copy was changed by secret redaction; exact lock hashes, dependency checks, and log redaction remain enforced.

The complete OpenClaw changes are in [the adapter patch](patches/openclaw-vercel-ai-gateway.patch), with [build instructions](patches/README.md). They target OpenClaw `2026.9.2` at `3928bad9badfcb6c7d140530435e806fb8092190` and native Codex `0.153.4`. No installed bundles were manually edited.

## Verification

Observed checks:

- 91 provider/controller tests pass; typecheck, provider build, and runner syntax checks pass.
- 337 focused core-auth and provider/adapter tests passed after the core repair.
- 53 focused tests pass for native config admission; a direct native-Codex config probe also passes.
- Canonical OpenClaw build and package integrity checks pass.
- 25 focused native/transport tests pass, including the actual pinned Codex child environment. The regression first failed because both CA variables were missing. Extension production/test types and focused lint pass.
- Independent read-only reviews found no blocking findings in the core/config, approval-controller, certificate-trust, mandatory-exclusion, and saved-verifier repairs. Reviewer model identity was not observable.

The aggregate OpenClaw changed gate remains failing because of historical max-lines baseline drift against newer upstream code. Focused checks above pass. No full security/lifecycle suite or upstream-landing validation is claimed.

## Reproduce

Use Node 26 and this package's pinned dependencies. Run locally:

```sh
npm test
npm run typecheck
npm run build
```

Build the patched OpenClaw package using [patches/README.md](patches/README.md). Set `OPENCLAW_CODEX_PACKAGE` and its SHA-256, then choose a fresh absolute `OPENCLAW_CODEX_INSTALL_DIR`:

```sh
node test/codex-e2e/run.mjs offline
node test/codex-e2e/run.mjs prepare-install
```

Preparation preserves registry integrity and the two-day release-age floor, with no exceptions. The live installer uses the resulting frozen lock.

Use an explicitly authorized disposable test project. Supply its project/team identifiers, project name, project-scoped OIDC file, an authorized AI Gateway key and catalog-listed model through the private environment. The runner validates the OIDC against this explicit scope. Set `OPENCLAW_E2E_RUN=1` and a fresh `OPENCLAW_E2E_RESULTS_DIR`. Do not put keys in shell history or checked-in files.

```sh
node test/codex-e2e/run.mjs preflight
node test/codex-e2e/run.mjs smoke
node test/codex-e2e/run.mjs verify-smoke
```

Preflight verifies setup only. A basic pass requires `CODEX_SMOKE_PASS` and `CODEX_SMOKE_RECEIPT_PASS`, plus independent confirmation that both VMs stopped. Its receipt cannot verify as full E2E.

Each run is bounded to two concurrent VMs, 45-minute VM timeouts, a 120-second turn deadline, and at most six initiated turns. Never reuse a result directory or resume a stopped test VM.

## Not tested

Full native-tool inventory, adversarial isolation, cancellation, worker loss/replacement, sleep/wake, webhooks, OAuth refresh, customer channels, and production hosting remain outside basic acceptance. No Connect or Workflow service was added.

## Sources

- [OpenClaw Codex cloud-worker placement](https://docs.openclaw.ai/plugins/codex-harness#run-codex-on-a-cloud-worker).
- [Vercel Codex configuration](https://vercel.com/docs/ai-gateway/coding-agents/openai-codex).
- [Native Codex config default](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/mod.rs#L4261).
- [OpenClaw approval presenter routing](https://github.com/openclaw/openclaw/blob/3928bad9badfcb6c7d140530435e806fb8092190/src/gateway/server-request-context.ts#L145).
- [Vercel Sandbox proxy CA certificates](https://vercel.com/docs/sandbox/concepts#proxy-ca-certificates).
