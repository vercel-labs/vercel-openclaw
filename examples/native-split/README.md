# Native OpenClaw with a Function gateway and one Sandbox

This experimental integration runs the OpenClaw gateway in a Vercel container Function and the native agent loop and file tools in one Vercel Sandbox. A Drive holds the node identity, worker bundles and managed workspaces. The gateway supplies coordination and transcript commits; worker inference is mandatory, with no local inference fallback.

The current cloud proof starts the native worker but its gateway WebSocket connection receives HTTP 503. No native model/file turn has completed; owner routing and gateway-instance lifetime remain unresolved. Gateway state currently uses the Function's temporary filesystem. It does not yet recover a conversation after the gateway instance disappears. Automatic owner replacement, external gateway storage, Slack delivery and one-hour idle/wake remain acceptance work. See [verification](reports/verification.md) for dated results.

```text
Native OpenClaw clients
        |
Vercel container Function
  HTTP/WebSocket wrapper -> native gateway
        |                         |
  Redis owner reservation         | native paired-node protocol
                                  v
                         One Vercel Sandbox
                         native node + agent
                                  |
                         Persistent worker Drive
```

The wrapper owns cloud allocation and checks a durable, non-expiring owner reservation. Another Function instance returns 503 instead of starting a competing gateway. This preserves exclusive admission but does not guarantee requests will reach the owner. There is no automatic takeover. An unreachable owner requires investigation; deleting its Redis key without confirming termination is unsafe.

The gateway receives only model metadata. The worker receives an opaque placeholder; the Sandbox firewall injects the AI Gateway credential at the model endpoint. For a protected Vercel deployment, its workload token is also injected by the firewall only for the configured deployment hostname. Neither actual token is placed in the worker's environment. These credentials still grant the requests allowed by that policy.

## Check the code

Use Node 24.21 or newer and an npm version compatible with the lockfile:

```sh
cd examples/native-split
npm ci
npm test
```

The tests exercise concurrent owner admission, duplicate allocation, attached-Drive refusal, control authentication, credential placement, HTTP body preservation and WebSocket upgrade forwarding. They do not substitute for the native cloud run.

The image builds OpenClaw at the full commit in [runtime.json](runtime.json), verifies the source archive checksum, installs with the frozen upstream lockfile and runs upstream's default full build. Both the gateway and node use that same build. The pin targets the experimental native worker implementation; see the [upstream native inference contract](https://github.com/openclaw/openclaw/blob/4a6520de4990169a45c6ea2cf64ff0dd44ba8c70/docs/gateway/cloud-workers/native-inference.md). The Sandbox image's Docker entrypoint is not used: the allocator explicitly runs the native node command.

## Deploy an isolated proof

This creates billable Function, Sandbox and Drive resources. Use a new Vercel project, a Redis database with durable storage and a write-capable REST credential, and an AI Gateway key. Keep existing Slack routing unchanged.

The image build and registry upload passed on an 8-CPU, 16-GB Enhanced builder. Use that tested configuration in the isolated project’s [build-machine settings](https://vercel.com/docs/builds/managing-builds) for the initial build. Standard 4-CPU, 8-GB completion remains unverified after three canceled attempts; this does not establish a minimum requirement. Restore any temporary build-machine override when testing is finished. See the dated verification for deployment and native execution results.

1. Link this directory to the isolated project with `vercel link`. Deploy once with `vercel deploy`. With no configuration, only `/_split/health` answers; the native gateway and worker do not start.
2. Inspect the deployment's container image and record its full VCR digest. Set `SPLIT_WORKER_IMAGE` to that digest. Use the same native source revision for the Function and worker; do not substitute an older OpenClaw release image.
3. Add the variables in [.env.example](.env.example) to the isolated project. Generate a random control token of at least 32 characters. The Function uses its own immutable `VERCEL_URL`; leave `SPLIT_PUBLIC_URL` unset in the deployment. Keep Deployment Protection enabled. The wrapper reads Vercel’s `x-vercel-oidc-token` from the bootstrap request and passes scoped credentials explicitly to the Sandbox SDK. It also uses that token for the worker’s protected connection back to the deployment.
4. Redeploy with those variables. The proof wrapper advertises that same deployment to the worker. Run `npm run smoke` with `SPLIT_PUBLIC_URL`, `SPLIT_CONTROL_TOKEN` and, for protected ingress, a fresh project `VERCEL_OIDC_TOKEN` in your local environment. Save its output privately.

The control API is an administrator-only proof interface. POST `/_split/bootstrap` claims ownership, starts the gateway, creates the one worker, issues a node-scoped setup code, waits for pairing, configures the required device profile and restarts the gateway before admitting messages. POST `/_split/session` creates an empty native workspace and waits for mandatory native placement on the enrolled worker. POST `/_split/message` submits a message using a caller-supplied stable idempotency key and waits for the native run result. POST `/_split/proof` independently reads the fixed test file from that worker session and retrieves the gateway transcript. GET `/_split/status` reports the runtime and worker identities to an authenticated operator.

An uncertain allocation is retained and never automatically repeated. A failed or timed-out turn blocks subsequent proof messages for inspection. The proof does not replay uncertain tool effects. Native HTTP and WebSocket traffic is forwarded without reducing it to a prompt string, but a Slack installation and durable event inbox are not implemented here.

## Persistence and lifecycle boundary

The worker Drive and gateway storage are separate. The gateway needs its complete SQLite-compatible state, including pairing, placement and transcripts, on a qualified external filesystem. A worker Drive alone cannot preserve those gateway records. Current `ephemeral-proof` mode intentionally declines any claim of gateway recovery.

The Redis reservation has no expiry and is never released by this example. It is an admission check, not filesystem fencing or a distributed storage contract. Do not manually rotate it during an active owner. Safe replacement requires evidence that the previous gateway process and its outstanding writes have stopped, then recovery from qualified gateway storage. Requests landing on a nonowner currently fail with 503; affinity or forwarding remains a routing integration step.

The worker session has a 65-minute cap for a bounded experiment. This is a maximum session duration, not one hour of measured inactivity. No idle timer, automatic worker replacement or scheduled wake is claimed. Function termination requests gateway shutdown and stops the exact allocated worker session, then checks Drive detachment. Abrupt termination can interrupt this cleanup; the 65-minute worker cap bounds that case, and the owner reservation remains held. Preserve failed Sandboxes and logs. Do not delete a reproducing resource as cleanup.

The captured runtime identity is short-lived; a request can receive a token with about 30 minutes remaining, which may be shorter than the worker’s 65-minute cap. This proof does not renew SDK credentials or the firewall’s deployment token. Complete the bounded smoke promptly; token renewal is required for unattended operation.

The initial native tool policy permits file read/write only. Richer tools, gateway-owned helpers, attachments, native Slack acknowledgment, full-hour idle/wake, provider credential refresh and gateway/worker replacement need separate qualification before enabling them.
