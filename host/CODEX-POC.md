# Codex native Slack sleep/wake PoC

Slack → Connect → Vercel Function → VM1 (OpenClaw + Codex) → VM2 (generated commands).

The host forwards the full Slack event to OpenClaw. Both apply explicit channel/user policy. The local approval client has only `operator.approvals`; the controller permits the exact session/run/worker/command-bound native exec-server launch once. VM2 has gateway-only egress. Reconciled project files return to VM1 as data.

After a reply, eyes/status clear and both VMs stay running. Same-thread messages reuse the gateway and worker; a new thread reclaims the old worker first. A private resident service holds the active-work guard and resets the idle clock on work. At 45 minutes idle it calls `/api/codex/sleep`. The Function verifies a session-bound capability, takes the same Redis lock as incoming messages, obtains fresh OIDC and asks the resident to recheck activity and prepare sleep. Only a ready OpenClaw suspension and confirmed current-session snapshot count as successful sleep. The next message restores disk, starts new processes and resets the clock.

This lifecycle revision is locally tested, not yet verified in a new deployed Slack run. Prepare a fresh VM1 for a new disposable test installation; an old runtime digest cannot run a changed host protocol. Do not replace an existing VM1 containing user state: read [existing installations](#existing-installations) first.

## Prerequisites

Use an isolated Vercel test project with Sandbox, Connect, an Upstash-compatible Redis REST store, a 300-second Function budget, and an approved AI Gateway testing key. Use Node 26, npm with `min-release-age` support, Git, tar and the upstream-pinned pnpm. Install both packages using the [root check sequence](../README.md#try-it). Keep registry/signature/release-age controls enabled.

Use one installed Connect Slack connector, one test channel and explicit human-user allowlists. Do not attach a second webhook destination to an existing deployment unintentionally. Setup incurs Sandbox usage; test mentions also incur model usage.

## 1. Build the pinned package

Follow [patches/README.md](../worker-provider/patches/README.md). It checks out the exact OpenClaw commit, applies both patches and invokes the canonical package builder. Codex and AI Gateway adapters are bundled; the official Slack package is installed separately at the same version.

Supply these values in your private shell environment. Paths must be absolute; generated directories must be fresh. Keep secrets in an approved store or ignored env file, never inline in shell history. From the repository root:

```sh
export OPENCLAW_CODEX_PACKAGE=/absolute/path/to/openclaw/.artifacts/vercel-codex-poc/openclaw-poc.tgz
export OPENCLAW_CODEX_PACKAGE_SHA256="$(shasum -a 256 "$OPENCLAW_CODEX_PACKAGE" | cut -d ' ' -f 1)"
export OPENCLAW_CODEX_INSTALL_DIR=/absolute/private/path/new-install
export OPENCLAW_CODEX_NATIVE_SLACK=1
cd worker-provider
node test/codex-e2e/run.mjs offline
node test/codex-e2e/run.mjs prepare-install
```

Expected markers: `CODEX_ARTIFACTS_PASS`, then `CODEX_INSTALL_LOCK_PASS`. Preparation verifies locked dependency ages/integrities and binds the installation record to this archive. Never reuse an older archive digest or installation record after rebuilding.

## 2. Prepare the snapshot and VM1

Supply `OPENCLAW_E2E_RUN=1`, `OPENCLAW_E2E_PROJECT_NAME`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, fresh project-scoped `VERCEL_OIDC_TOKEN`, `AI_GATEWAY_API_KEY`, and a catalog-listed `OPENCLAW_E2E_MODEL`. The scripts validate the OIDC project's name/team/id and require it to outlive the test budget. Unset `VERCEL_TOKEN` when using OIDC.

Set `OPENCLAW_NATIVE_SLACK_CONFIG` to your Slack IDs, e.g. `{"teamId":"TEXAMPLE","channels":["CEXAMPLE"],"users":["UEXAMPLE"]}`. This policy is pinned into VM1; changing it requires preparing a matching VM1 and host configuration.

From `worker-provider/`:

```sh
export OPENCLAW_E2E_RESULTS_DIR=/absolute/private/path/new-image-results
node scripts/prepare-snapshot.mjs
```

This installs once into `openclaw-foundation/openclaw/openclaw@sha256:30134c3d1427a06e86060257ae1a7a31e71dd5925459d84dd746d1da25a84a6d`, verifies the runtime offline, snapshots it and stops the builder. Set `OPENCLAW_CODEX_SNAPSHOT` to `snapshotId` in the private receipt, then:

```sh
export OPENCLAW_E2E_RESULTS_DIR=/absolute/private/path/new-host-results
# Pro/Enterprise only. Omit on Hobby, whose maximum total session is 45 minutes.
export OPENCLAW_CODEX_SESSION_TIMEOUT_MS=86400000
node scripts/prepare-host.mjs
```

Expected marker: `CODEX_HOST_PREPARED`. Preserve the receipt's `name` and `runtimeDigest`. It registers the official Slack plugin, prepares the guarded tool catalog and leaves VM1 stopped, without a model turn or Slack message. The host refuses to silently replace missing saved state.

The preparation scripts independently verify that the worker base and initial VM1 checkpoint are ready, belong to the expected source session, and have no expiration. VM1 keeps its latest two snapshots and deletes older checkpoints. The pinned worker base is retained until explicitly deleted: keep it while any installation still references its ID, then remove it during that installation's decommissioning. Non-expiring snapshots continue to incur storage charges; deleting a sandbox does not delete its snapshots. See [Vercel's snapshot retention contract](https://vercel.com/docs/sandbox/concepts/snapshots#snapshot-retention).

### Existing installations

Deploying the updated host sets retention on the existing, ownership-checked VM1 before work and before sleep. New checkpoints must pass an independent no-expiry check before sleep is reported successful. This does not prove that an older snapshot's expiration changed retroactively, and it does not update the immutable worker snapshot ID stored in VM1's runtime manifest.

The pinned SDK has no API for changing an existing snapshot's expiration. An old seven-day worker base therefore needs a new non-expiring base and a coordinated update of VM1's manifest, runtime digest, ownership tag and host configuration. This repository does not yet automate that state-preserving migration. For disposable test state, prepare a fresh isolated installation. For state that must survive, pause admission and plan the migration before the old snapshots expire; do not rerun `prepare-host.mjs` as a replacement for the original VM1. Preserve the existing workspace, OpenClaw state and allocation journal, and verify the replacement checkpoints and a resumed turn before retiring the old resources. Missing or expired state must stop the migration, never trigger a clean rebuild under the same name.

The one-time builder stops before VM1 preparation. During work there is VM1 plus one VM2, with no third always-running VM. Both have the prepared session limit. Hobby defaults to 45 minutes total. Shutdown begins three minutes before that ceiling; a new turn requires an additional 235-second execution budget and otherwise rolls over first. Activity cannot extend the platform limit. Use a longer Pro/Enterprise session for the full 45-minute idle test below. OpenClaw's paired-node adapter owns a separate Codex client per turn; this revision does not change that upstream behavior.

## 3. Configure and deploy host/

Deploy `host/` as the project's Root Directory with:

| Variable | Value |
| --- | --- |
| `OPENCLAW_ENGINE` | `codex` |
| `OPENCLAW_CODEX_NATIVE_SLACK` | `1` |
| `OPENCLAW_NATIVE_SLACK_CONFIG` | Same JSON allowlists pinned into VM1 |
| `OPENCLAW_ALLOWED_SLACK_USERS` | Same human Slack IDs, comma-separated; empty fails closed |
| `OPENCLAW_CODEX_SANDBOX_NAME` | Prepared receipt's `name` |
| `OPENCLAW_CODEX_RUNTIME_DIGEST` | Prepared receipt's `runtimeDigest` |
| `OPENCLAW_CODEX_SLEEP_URL` | Public HTTPS URL ending `/api/codex/sleep`; defaults to the production project URL |
| `OPENCLAW_GATEWAY_TOKEN` | Strong random gateway credential from your secret store |
| `SLACK_CONNECTOR` | Existing connector UID, e.g. `slack/openclaw` |
| `AI_GATEWAY_API_KEY` | Approved testing key |
| `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Prepared sandbox's project/team |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis REST pair; alternatively `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` |

Vercel supplies runtime OIDC. Local preparation needs fresh project OIDC. The model is pinned in the preparation manifest, not selected by legacy `OPENCLAW_MODEL`.

From `host/`, create a connector only if you do not have one:

```sh
vercel connect create slack --name openclaw --triggers --trigger-path /api/slack
```

Attach the chosen connector to the intended deployment environment:

```sh
vercel connect attach slack/openclaw --environment production --triggers --trigger-path /api/slack
```

Invite the app to the allowed test channel. Ensure it has app-mention delivery, `chat:write`, `reactions:write`, `channels:history`, `channels:read` and `users:read`; the observer also requests `reactions:read`. Deployment protection must admit Connect's forwarded request and the authenticated sleep callback. The callback sends the latest project OIDC token through `x-vercel-trusted-oidc-idp-token`; [Trusted Sources](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/trusted-sources) allows same-project, same-environment access by default. Keep that rule if customizing Trusted Sources, and use a callback URL in the host's deployment environment. The session-bound capability still authenticates the application endpoint. A blocked callback cannot stop/snapshot a VM gracefully. Avoid duplicate production/preview destinations.

Codex mode does not need Cron or Workflow. `vercel.json` no longer installs the historical five-minute cron, which is unavailable on Hobby. Users of the legacy non-Codex path must explicitly configure `/api/cron/idle-check` on a supported plan.

Slack/model credentials are injected by VM1's firewall, not stored in the guest. A localhost relay removes the Slack SDK's placeholder body token before forwarding to the fixed Slack API origin. Sandbox administration and gateway credentials remain in trusted controller scope. Connect verification proves project/environment OIDC, not an exact connector identity.

## 4. Native Slack test

`npm run test:e2e:slack` observes three native turns with an idle period after the warm follow-up. It never sends messages, creates VMs or resumes them itself. You send mentions through Slack; the deployed host performs the lifecycle. `test:e2e:host` is a historical per-turn-stop fixture and does not verify this revision.

Create a new short thread in the allowed channel (an ordinary message without mentioning the bot is enough). In a fresh private `OPENCLAW_E2E_RESULTS_DIR`, save `fixture.json`, replacing IDs, timestamp and public test value:

```json
{
  "mode": "idle",
  "channel": "CEXAMPLE",
  "user": "UEXAMPLE",
  "bot": "UBOT",
  "thread": "1234567890.123456",
  "file": "persisted.txt",
  "value": "spruce-826",
  "cases": [
    { "label": "write", "role": "write" },
    { "label": "warm", "role": "read" },
    { "label": "wake", "role": "read" }
  ]
}
```

Use a new public `word-digits` value each run, never a secret. If your sending client automatically appends a Slack app attribution, set `senderAttributionUser` to that exact app's user ID in the fixture; the verifier accepts only that exact footer. Omit it for manually sent messages. Export the same project credentials, sandbox name/digest, native policy and `SLACK_CONNECTOR` as above. From `worker-provider/`:

```sh
npm run test:e2e:slack -- observe write
```

Wait for `OBSERVER_ARMED`, then paste its printed prompt into that thread, replacing the placeholder with an actual mention of your bot. Send exactly one mention. Wait for `OBSERVATION_COMPLETE write`, then:

```sh
npm run test:e2e:slack -- observe warm
```

Again wait for `OBSERVER_ARMED` and send its prompt in the same thread. It omits the saved value. Wait for `OBSERVATION_COMPLETE warm`. Both VMs should still be running. Then leave the conversation idle and run:

```sh
npm run test:e2e:slack -- idle
```

Wait for `IDLE_SLEEP_OBSERVED` after the full idle interval. The observer uses platform metadata only and does not wake the VM. Then run `npm run test:e2e:slack -- observe wake` and send its prompt after `OBSERVER_ARMED`. Wait for `OBSERVATION_COMPLETE wake`. From the linked `host/` directory, export that deployment's Function logs for the test interval (set `DEPLOYMENT_URL` and `TEST_STARTED_AT` to your deployment and ISO start time):

```sh
vercel logs "$DEPLOYMENT_URL" --since "$TEST_STARTED_AT" --json --limit 100 > "$OPENCLAW_E2E_RESULTS_DIR/requests.jsonl"
```

The verifier accepts request objects containing `logs` or individual log objects with `message`. Return to `worker-provider/`:

```sh
npm run test:e2e:slack -- verify
```

Success prints `NATIVE_SLACK_WARM_IDLE_WAKE_PASS`. It requires exact prompts, unique admission/delivery and completion, matching file hashes, the same VM1 session/gateway PID/worker for the warm follow-up, an idle-triggered stop and current-session snapshot, and restored files in a fresh VM session/worker on wake. A hard-deadline stop or an accelerated interval cannot pass as 45-minute inactivity. The final wake deliberately leaves the VMs warm; allow another idle period to observe final cleanup. Fixtures without `mode: "idle"` remain available only to verify historical per-turn-stop evidence.

Missing evidence fails. A timeout does not prove cleanup; inspect exact resources and host logs before retrying. Observation files cannot be overwritten; use a fresh directory/thread after a failed run. The observer reads only the running platform session, never sandbox-level filesystem reads that can wake a stopped VM. Use a short thread and honor Slack's rate-limit delay. Evidence contains Slack text and runtime IDs: keep it private.

## Validation and limitations

September 10 native tests demonstrated Connect delivery, VM2 command execution, matching file hashes across sleep/wake and stopped sandboxes. Recent reply durations derived from Slack timestamps were 60.2, 81.5, 67.3 and 98.1 seconds. The 67.3-second run's observer attached too late for independent file evidence, so that read was repeated with the observer prearmed. These are observations, not a benchmark or a consistent demonstrated speedup.

The [root README](../README.md#limits) lists product limits. Same-thread recall may use Slack history; it does not prove disk-only model memory. Cross-thread memory is disabled. No durable post-ack queue, crash recovery, scheduled wake or OAuth-expiry test is included. VM1 remains trusted with broad outbound access. This is not an adversarial security certification.

VM sessions default to 45 minutes total; Pro/Enterprise preparation can select up to 24 hours. New VM1 checkpoints retain the latest two without time-based expiry, and newly prepared worker bases do not expire. Existing worker pins require the upgrade described above. Host turns have a 235-second execution cap, shortened by the remaining Function budget to reserve cleanup time. Connect supplies event forwarding and tokens; the host owns process restart, reconciliation and sleep.

### Existing dependency audit findings

The unchanged host lockfile reported five npm audit findings on September 10: one critical, two high and two moderate. Next.js and sharp are runtime dependencies; js-yaml and Vitest/mocker are development dependencies. The Next.js advisories concern [Windows-hosted servers](https://github.com/advisories/GHSA-p293-qw3h-jr36) and [AVIF image optimization](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4); the [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) concerns processing untrusted image input. This headless PoC does not intentionally process images, but exploitability/reachability has not been verified. Update and retest these dependencies before broader deployment. Passing the functional tests or secret scan does not clear these advisories.
