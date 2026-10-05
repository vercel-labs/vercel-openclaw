# OpenClaw with Vercel Drives

Run the official OpenClaw image in Vercel Sandbox, with a Drive holding its saved state. CLI and HTTP requests start fresh compute and shut down after each message. The optional Slack adapter keeps one VM and gateway warm until one hour of inactivity, then shuts down and releases the Drive.

This is a small persistence example. The default agent uses OpenClaw's native engine through Vercel AI Gateway, with file read/write tools. It includes an optional native Slack test adapter. It does not include the separate Codex execution worker from the existing integration.

## Status

The initial live restart test passed on September 28, 2026: one preparation VM, two fresh OpenClaw VMs, and four model turns verified saved files, conversation continuity and native memory loading. The example includes an authenticated HTTP controller with Redis request tracking, runnable locally or as Vercel Functions. The Slack adapter now includes warm reuse and delayed idle shutdown; see the [dated Slack verification results](reports/slack-warm-verification.md). Continuous hosted operation remains unverified.

The gateway and built-in agent run in the same VM, matching OpenClaw Enterprise’s embedded topology. There is no hard isolation boundary between them. The current scope is one allowed Slack user/channel and file read/write tools; skills, cron, heartbeat and automatic memory flushing are disabled. See the [Enterprise comparison and follow-ups](reports/enterprise-follow-ups.md) before broadening access or claiming unattended operation.

## What persists

One Drive mounts at `/data`. The agent state directory is `/data/openclaw`, selected through `OPENCLAW_STATE_DIR`. It holds OpenClaw's configuration, agent session database, workspace, and `MEMORY.md`. OpenClaw itself and its installed tools come from the official image.

The example uses OpenClaw `2026.9.6` and Sandbox SDK `3.5.0`. The launcher verifies the running OpenClaw version and records the resolved image digest. The restart test uses that exact digest for its second VM. Both VMs have `persistent: false`; the test does not resume a sandbox or restore its filesystem snapshot.

Drives allow one writable sandbox at a time. A second invocation against an attached agent Drive fails rather than taking over the existing session. The example uses `iad1` and a 1 GiB maximum Drive size.

## Setup

Use Node.js 22.21 or newer and a Vercel project with Sandbox access. You need a project-scoped Vercel OIDC token and a [Vercel AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-security/authentication).

From the repository root:

```sh
cd examples/drives
npm ci
vercel link
vercel env pull
```

Add your `AI_GATEWAY_API_KEY` to the ignored `.env.local`, or export it in your terminal. Keep credentials out of source control. `.env.example` documents the optional image and model settings; do not copy it over the file produced by `vercel env pull`.

```sh
npm run preflight
```

Preflight checks local credential presence, token expiry and configuration. The API still authenticates the token; a preflight pass does not prove remote project access or image availability. An expired token requires another `vercel env pull`.

To use a different ignored environment file:

```sh
npm run preflight -- --env-file /path/to/project/.env.local
```

The official image reference is `openclaw-foundation/openclaw/openclaw:2026.9.6`. Only this release tag or an explicit digest is accepted. The release tag itself is not immutable; use an approved digest when a fixed artifact is required. If the release is unavailable or still preparing in VCR, inspect the error before retrying; do not silently substitute another release. The default model is `openai/gpt-5.4` through a custom `gateway` provider using OpenClaw’s built-in Chat Completions adapter. This needs no additional provider plugin.

## Verify a fresh restart

```sh
npm run verify:restart
```

This command creates a new Drive, one preparation sandbox and two OpenClaw sandboxes, and makes four bounded agent turns. Compute, Drive storage, and AI Gateway requests are billable. It checks:

1. Sandbox A writes exact memory and project-file contents using native file tools.
2. A second turn recalls a separate conversation-only marker with the same OpenClaw session identity.
3. A exits cleanly and releases the Drive.
4. Fresh sandbox B mounts the same Drive and matches the saved file hashes and symbolic-link targets before starting OpenClaw. Links to image-shipped skills are recorded without following them.
5. B recalls the earlier conversation with the same OpenClaw session identity.
6. A new conversation in B recalls the memory marker, with evidence that OpenClaw injected `MEMORY.md` into that run and that the turn made zero tool calls.
7. B exits cleanly and releases the Drive.

Each command and resource ID is recorded under an ignored `results/` directory. Receipts separate exact file recovery, conversation recall, native memory loading, and process replacement. Gateway model credentials are injected by the Sandbox firewall and are not passed into the VM. Gateway authentication uses a fresh local token for each run.

Successful runs stop their sandboxes and retain the Drive for inspection. Failed runs retain resources and logs. Preparation VMs have a 2-minute timeout; OpenClaw VMs have a 15-minute timeout. This example never deletes sandboxes or Drives. Inspect and explicitly manage retained resources afterward; stopped compute does not remove Drive storage charges.

## Use a persistent agent

Initialize each new agent once:

```sh
npm run init -- --name personal
```

Initialization runs in a managed Node.js 24 sandbox with outbound networking blocked and no model credentials. It checks the Drive for unexpected content, preserves its filesystem recovery directory, creates the agent state directory owned by OpenClaw's `node` user (1000:1000), then stops and waits for the Drive to detach. Re-running `init` validates and preserves an already prepared Drive.

```sh
npm run agent -- --name personal --message 'Remember that I prefer TypeScript.'
npm run agent -- --name personal --message 'What language do I prefer?'
```

Each command uses a fresh VM. The agent name selects its Drive, and the conversation defaults to `main`. Use `--session another-conversation` to start a separate conversation with the same saved workspace and memory.

OpenClaw configuration initialization only runs in a prepared state directory containing no other agent files. Existing owned state is preserved. An unknown nonempty Drive, changed configuration, or different runtime version requires explicit inspection or migration. The launcher does not overwrite it automatically.

## Startup and shutdown

Sandbox does not automatically execute Docker `ENTRYPOINT` or `CMD`. This launcher explicitly runs the release's `tini -s -- node /app/openclaw.mjs gateway` command as the image's existing default `node` user, without invoking `sudo`, and waits for its local health endpoint. It exposes no public port. A live probe found that the official image has no `sudo` and a new Drive mounts root-owned, which is why Drive preparation runs separately.

After the turn finishes, the launcher sends SIGTERM, allows up to 335 seconds for graceful exit, waits for exit code zero, and requires OpenClaw's explicit clean-shutdown log. It rejects timeout or incomplete-cleanup evidence even when the process exited zero. It then stops the VM and polls until the Drive detaches.

The HTTP controller below starts compute on demand. Scheduled wakeups, automatic replay after crashes, uninterrupted execution, runtime upgrades, shared writable dependency caches, and multi-user isolation are outside this example. Embedding search and background memory maintenance are disabled for the acceptance test; native Markdown memory loading remains enabled.

## HTTP controller

The controller accepts a message, automatically prepares a new agent Drive when needed, starts a fresh OpenClaw VM, and returns the reply after clean shutdown and Drive detach. Redis holds request status; the Drive holds OpenClaw state. The local server listens only on `127.0.0.1`. The Vercel Functions adapter exposes the same contract at `/api/messages` and `/api/requests`.

Add `KV_REST_API_URL` and `KV_REST_API_TOKEN` for your Redis REST database to the ignored environment file. Use a write-capable token. Generate a control token in the terminal, then start the server:

```sh
export OPENCLAW_CONTROL_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run serve
```

The same `--env-file` option is available with `serve`. Keep this terminal environment available when making requests, or securely supply the same control token in another terminal.

```sh
curl --fail-with-body http://127.0.0.1:8787/messages \
  -H "Authorization: Bearer $OPENCLAW_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent":"personal","requestId":"message-001","conversation":"main","message":"Remember that I prefer TypeScript."}'

curl --fail-with-body \
  'http://127.0.0.1:8787/requests?agent=personal&requestId=message-001' \
  -H "Authorization: Bearer $OPENCLAW_CONTROL_TOKEN"
```

Each new message needs a unique `requestId`. Keep that ID and the same payload when retrying after a lost HTTP response. While the request is running, a duplicate returns HTTP 202 with saved status. Once it finishes, a duplicate returns HTTP 200 with the saved result and does not dispatch another turn. Inspect `job.status`, not just the HTTP status: a saved failure or interruption also returns HTTP 200 on lookup or duplicate submission. Conflicting reuse of an ID and a competing message for the same agent return HTTP 409.

Request records expire after 7 days. Deduplication is limited to that retention window; it is not an exactly-once execution guarantee. A new ID can execute new work even when an earlier request had an uncertain outcome. Do not use a new ID to bypass an interruption.

The controller reserves one writer per agent with a 30-minute ownership lease. It also checks the Drive's exclusive attachment. If the controller disappears, a lookup or duplicate submission after lease expiry marks the request `interrupted` and preserves its resource IDs. There is no automatic replay, resource takeover, or background reconciliation. Before recovery, inspect the recorded sandbox and wait for it to stop and release the Drive. The model may already have written state even if its reply was never recorded.

Redis errors prevent further dispatch; a failure can leave a sandbox running until its timeout. Keep Redis configured to retain these records: data loss or eviction removes the controller's duplicate history. `OPENCLAW_CONTROLLER_NAMESPACE` defaults to the Vercel project ID and must stay stable across controller restarts. Agent Drive names are project-scoped and do not change with this namespace. Existing agent metadata rejects a changed runtime configuration pending an explicit migration.

The control token grants access to all agents in this controller. This example has no user account isolation. Requests remain open during cold startup and model execution. The hosted functions have an 800-second limit; a platform timeout can interrupt processing and must be treated as an uncertain outcome.

## Deploy and test before merging

A PR does not need to be merged to test this example. From `examples/drives`, link a separate Vercel test project with Node.js 24 and OIDC enabled. Use a plan supporting the configured 800-second function duration. Keep this project's Slack routing separate from an existing installation.

```sh
npm ci
vercel link
```

In that project's settings, supply `AI_GATEWAY_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` and a random `OPENCLAW_CONTROL_TOKEN` for the deployment environment. Use a write-capable Redis token. A new project's first deployment can be classified as production; configure these variables for both Preview and Production in the separate test project. Do not copy `VERCEL_OIDC_TOKEN` into hosted environment settings: the adapter obtains the current invocation's platform token through `@vercel/oidc`.

```sh
vercel deploy
```

Use the returned deployment URL with `/api/messages` and `/api/requests` in place of the local URLs above. Keep deployment protection enabled; use an authenticated client such as `vercel curl` when testing a protected preview, alongside the API's control token. There is no need to merge or promote the existing application to run these tests.

With the Vercel CLI authenticated and this directory linked to the same test project, run the hosted verification using an ignored environment file containing `OPENCLAW_CONTROL_TOKEN`:

```sh
npm run build
node test/hosted.live.mjs https://your-deployment.example /path/to/control-token.env
```

It makes three synthetic model turns with a new Drive, checks conversation and memory recall across fresh VMs, and verifies auth, oversized messages, duplicate requests and competing admission. It uses `vercel curl` for deployment protection and records observed HTTP times under ignored `results/`. See the [bounded hosted test results](reports/hosted-verification.md).

Redis stores request status and resource IDs across function instances. Diagnostic receipts under `/tmp` are temporary on Vercel; they are not a durable log archive. Inspect the recorded Sandbox session and command logs for failures and export evidence before relying on long-term retention. A production service needs its own durable diagnostic storage.

## Optional Slack test adapter

The adapter receives Connect webhooks at `/api/slack`, verifies the request and checks an explicit workspace, app, channel, user and bot allowlist. It accepts human `app_mention` events only. It preserves the complete UTF-8 event body, including whitespace and unknown fields, and records its SHA-256. Bodies above 1 MiB and text above 40,000 characters are rejected rather than truncated. The plain HTTP message API retains its separate limits.

Ingress acknowledges an allowed event only after Vercel Queues accepts it. Redis binds the event identity to its body hash for 7 days. A separate secret authenticates the queued payload before the worker obtains credentials or starts compute. The worker also verifies that its Connect token belongs to the configured workspace and bot. Queue retention is 24 hours; request deduplication is bounded by Redis retention and does not guarantee exactly-once execution.

One agent Drive belongs to each workspace/app/channel combination. Slack threads select conversations. A worker reuses the running VM and gateway while the agent is active. On a cold start it creates a VM, installs the pinned official `@openclaw/slack@2026.9.6` plugin on the Drive when absent, then forwards the original body to OpenClaw's local native Slack endpoint. Slack and AI Gateway credentials are injected by the Sandbox firewall. The guest receives placeholder provider tokens. A loopback Slack proxy removes placeholder token fields before the firewall supplies authorization; native startup also checks this request format against the configured bot and workspace. Registry access is enabled only during installation.

Native hooks correlate receipt of the message, successful agent completion and Slack delivery. After each reply, the worker drains and resumes the gateway, records a completed `warm` job and schedules an idle check. Each completed turn resets the one-hour inactivity timer. The idle consumer shares the turn's ownership lock, checks the current runtime generation and native activity, then confirms clean gateway exit, VM stop and Drive detach. A platform session approaching its maximum lifetime rolls over through the same clean handoff before another turn.

An eyes reaction acknowledges an admitted mention before VM startup. Reaction failures are recorded without preventing the agent turn. Duplicate events do not execute a second turn or reset the idle timer.

An uncertain or failed turn is retained for inspection and is not automatically replayed. A busy agent retries the same queued event. Warm VMs retain the Drive mount and consume allocated resources during the idle window. The plain HTTP test adapter continues to stop after each request.

### Configure an isolated test

Keep the existing deployment's Slack destination unchanged. Use a separate test channel outside its allowlist, or a separate bot. Do not route the same bot/channel to two active deployments.

In the linked test project's target environment, configure:

- `SLACK_CONNECTOR`: a Connect Slack connector attached to that project and environment, with app-subject access to `channels:read`, `channels:history`, `users:read`, `chat:write` and `reactions:write`.
- `OPENCLAW_SLACK_POLICY`: JSON with `teamId`, `appId`, `channelId`, `userId` and `botUserId` from the actual Slack installation.
- `OPENCLAW_SLACK_QUEUE_SECRET`: a random secret of at least 32 characters, separate from `OPENCLAW_CONTROL_TOKEN`.
- The AI Gateway and Redis variables documented above.

Enable the connector's event destination at `/api/slack` only after the deployment is ready and the channel/bot is isolated. For a CLI-only test project, use its stable Production destination; a branch destination requires a resolvable Preview branch alias. This endpoint expects Connect verification; do not point Slack directly at it. The verifier authenticates the Connect project/environment boundary, not an individual connector or a body-bound Slack signature. The explicit event policy is an additional admission check.

Keep the queue signing secret and controller namespace stable across deployments for at least the 24-hour queue retention window, so pending message and idle callbacks can still be verified.

For a local readiness test, use an ignored environment file with project OIDC, Gateway and Slack settings. Attach the connector for the environment in that token; a local token may be development-scoped even when environment values were pulled from Preview.

```sh
npm run build
node test/slack-readiness.live.mjs /path/to/ignored-test.env
```

The script creates a new Drive and two fresh workload VMs, checks plugin reuse, explicit body-token authorization and native Slack readiness, and drains/stops each VM. It sends zero Slack events and makes no model turns. Running it incurs Sandbox and Drive charges, and retained Drives remain billable.

For the actual E2E check, a person mentions the test bot and asks it to save a unique marker in a workspace file and `MEMORY.md`. After the recorded job completes with phase `warm`, they mention the bot again in the same thread and ask it to recall the marker. Verify the eyes reaction, reply thread, event/body hash, unchanged VM/gateway identity and stable Drive. After one hour of inactivity, verify clean shutdown and detach; the next mention must use a new VM and recover the saved state. Repeat with a new thread if testing cross-conversation memory.

**The previous stop-after-each-turn configuration passed two user-originated Slack turns**, with distinct VMs, the same Drive and native conversation, correct replies and clean shutdown. A live readiness test also reused the same VM and gateway, then stopped it after a shortened idle interval and recovered a saved file in a fresh VM. A separate hosted test verified delayed Queue delivery, VM shutdown and Drive detach. User-message warm latency, acknowledgment and the full one-hour idle interval still need live verification. A complete envelope does not contain every thread message or attachment's bytes. File download permissions/egress, attachment handling, full thread history and long-message delivery need dedicated live tests before claiming parity.

## Latency scope

No speedup over the existing Slack/Codex integration is established. The earlier Slack configuration took 67.009 and 60.182 seconds from user message to reply while starting a fresh gateway for each request. Those are two individual observations derived from Slack timestamps. The new Slack lifecycle reuses its VM and gateway for up to one hour of inactivity; improved latency must be measured. The plain HTTP adapter still starts a fresh gateway per request. The earlier integration can reuse warm VMs and has a separate code-execution worker. Compare equivalent model/tool workloads and measure startup, model execution and shutdown separately before claiming an improvement.

## Live controller checks

Build once, then run the explicit live scripts with your ignored environment file:

```sh
npm run build
node test/redis.live.mjs /path/to/project/.env.local
node test/controller.live.mjs /path/to/project/.env.local
```

The Redis test uses a unique namespace. The controller test uses a new agent Drive and namespace, makes bounded model calls, exercises three fresh message VMs, restarts the local controller, and checks duplicate and competing requests. It also kills a synthetic controller before dispatch and kills an idle OpenClaw gateway, followed by a supported Sandbox stop and a fresh VM. The crash test waits five minutes after the VM stops, allowing the pinned release's gateway ownership lease to expire. An immediate replacement failed with `Another Gateway owner lease is still active for this state directory`. The controller does not automatically wait and retry this case; inspect the failed request and retained resources first.

These fault tests do not simulate VM power loss or interruption during a model tool call. Resources and diagnostics are retained; running the tests incurs Sandbox, Drive and model charges. Append `--controller-only` after the environment-file path to exercise the HTTP/controller boundary without the native gateway crash and cooldown.

## Local checks

```sh
npm run typecheck
npm test
```

These checks verify configuration and lifecycle failure handling with controlled adapters. They do not replace the live restart test.

## Sources

- [OpenClaw 2026.9.6 Dockerfile](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/Dockerfile)
- [Pinned custom-provider configuration](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/docs/concepts/model-providers/custom-providers.md)
- [AI Gateway Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions)
- [Pinned agent CLI documentation](https://github.com/openclaw/openclaw/blob/eb377ac59e6c9fd6c7705028034812becf00271b/docs/cli/agent.md)
- [Sandbox managed images](https://vercel.com/docs/sandbox/concepts/images)
- [Sandbox Drives](https://vercel.com/docs/sandbox/concepts/drives)
- [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference)
- [Credential brokering](https://vercel.com/docs/sandbox/concepts/firewall#credentials-brokering)
