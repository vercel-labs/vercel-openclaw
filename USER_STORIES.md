# User Stories — vercel-openclaw

Every user-facing behavior extracted from the codebase, organized by domain.

---

## 1. Authentication & Authorization

### Sign-in with Vercel (OAuth)
- As a **visitor**, I want to see a "Sign in with Vercel" button on the landing page so that I know how to access the admin panel.
- As a **visitor**, I want to be redirected to Vercel's OAuth flow when I click "Sign in with Vercel" so that I can authenticate with my Vercel account.
- As a **visitor**, I want the OAuth flow to use PKCE (code verifier + nonce) so that the authorization is secure against interception.
- As a **visitor**, I want my OAuth state stored in an encrypted short-lived cookie (5 min TTL) so that the callback can verify the request without server-side session storage.
- As a **visitor**, I want to be redirected back to my intended destination (`?next=` param) after successful authentication so that I don't lose my place.
- As an **authenticated user**, I want my session stored in an encrypted HttpOnly cookie (7-day TTL) so that my credentials are secure and persistent across browser sessions.
- As an **authenticated user**, I want to see my name or email displayed in the admin header so that I know which account I'm signed in with.
- As an **authenticated user**, I want to sign out via the "Sign out" link so that I can end my session.
- As an **authenticated user**, I want my access token refreshed automatically before expiry so that I don't get logged out mid-session.
- As an **authenticated user**, I want a failed token refresh to clear my session and force re-login so that stale credentials don't cause confusing errors.

### Deployment Protection Mode
- As an **operator**, I want to use Vercel's built-in deployment protection as the default auth mode so that I don't need to configure OAuth credentials.
- As an **operator**, I want to switch between `deployment-protection` and `sign-in-with-vercel` auth modes via the `VERCEL_AUTH_MODE` environment variable so that I can choose the right auth strategy for my deployment.

### Auth Enforcement
- As an **unauthenticated user**, I want to receive a 401 response with an `authorizeUrl` when I hit any protected API endpoint so that the client knows where to redirect me.
- As an **authenticated user**, I want all admin API endpoints to verify my session before executing so that unauthorized users cannot control the sandbox.
- As a **developer**, I want auth checks applied before any proxy request that serves HTML containing the gateway token so that the token is never leaked to unauthenticated users.

### Credential Security
- As the **system**, I want ID token nonce verified during the OAuth callback so that replay attacks are prevented.
- As the **system**, I want timing-safe string comparison used for OAuth state validation so that timing attacks are mitigated.
- As the **system**, I want OAuth context cookies cleared after the callback so that temporary credentials aren't retained.

---

## 2. Sandbox Lifecycle

### Creation
- As an **admin**, I want to click "Ensure running" to create a new sandbox if none exists so that the OpenClaw instance gets bootstrapped automatically.
- As the **system**, I want sandbox creation to proceed through `uninitialized → creating → setup → running` status transitions so that the UI can show progress.
- As the **system**, I want OpenClaw bootstrap to install the `openclaw` binary, write config, write the gateway token file, write the AI Gateway key, and write a restore startup script so that the sandbox is fully configured on first create.
- As the **system**, I want the sandbox created with a 30-minute default timeout so that idle sandboxes don't consume resources indefinitely.
- As the **system**, I want the sandbox to use a lifecycle lock (with auto-renewal) so that concurrent create/restore requests don't race.
- As the **system**, I want a separate start lock to prevent concurrent start attempts so that double-creates are impossible.
- As the **system**, I want stale operations (>5 min without update) to be detected and re-triggered so that a stuck create doesn't permanently block the sandbox.

### Running State
- As an **admin**, I want to see the current sandbox status (uninitialized, creating, setup, booting, running, stopped, restoring, error) on the Status panel so that I know the sandbox's state at a glance.
- As an **admin**, I want to see the sandbox ID and snapshot ID on the status panel so that I can identify the current instance.
- As the **system**, I want active proxy requests to automatically extend the sandbox timeout (15 min extension, throttled to once per 30 sec) so that the sandbox doesn't time out while in use.
- As the **system**, I want the AI Gateway OIDC token refreshed inside the sandbox every 10 minutes so that the AI backend stays authenticated without manual intervention.
- As the **system**, I want the gateway probed for readiness by checking for the `openclaw-app` marker in the HTML response so that the status accurately reflects whether the gateway is serving.

### Stopping
- As an **admin**, I want to click "Snapshot and stop" to create a point-in-time snapshot and stop the sandbox so that I can preserve state and free resources.
- As an **admin**, I want a confirmation dialog before stopping the sandbox so that I don't accidentally destroy a running session.
- As the **system**, I want the stop action to transition the status to `stopped`, clear the sandbox ID and port URLs, and record the snapshot in history so that state is consistent.

### Snapshotting
- As an **admin**, I want to click "Snapshot now" to take a hot snapshot of the running sandbox so that I can create a save point without stopping.
- As an **admin**, I want a confirmation dialog before snapshotting so that I understand what will happen.
- As an **admin**, I want to see the snapshot history panel with all past snapshots, their IDs, timestamps, and reasons (manual, auto, bootstrap, stop) so that I can track state changes over time.
- As an **admin**, I want each snapshot labeled as "Current" or "Available" so that I know which one is active.
- As an **admin**, I want to see relative timestamps ("5m ago", "2h ago") on snapshots so that I can quickly assess recency.

### Restoring
- As an **admin**, I want to click "Restore" on any historical snapshot to restore the sandbox to that point-in-time so that I can recover from errors or revert changes.
- As an **admin**, I want a confirmation dialog warning that unsaved state will be lost before restoring so that I make an informed decision.
- As the **system**, I want restore to write a fresh AI Gateway token, re-write config and skill files, run the startup script, and force-pair the device identity so that the restored sandbox works with current credentials.
- As the **system**, I want restore to apply the current firewall policy to the restored sandbox so that security settings carry over.
- As the **system**, I want the system to automatically restore from the latest snapshot when the sandbox is stopped and an "ensure running" is triggered so that users don't need to manually pick a snapshot.
- As the **system**, I want the system to fall back to creating a fresh sandbox if no snapshot exists so that the ensure flow always results in a running sandbox.

### Error Handling
- As an **admin**, I want to see the last error message displayed as a red banner on the status panel so that I can diagnose problems.
- As the **system**, I want lifecycle failures to transition the sandbox to "error" status and record the error message so that the failure is visible and the system doesn't get stuck.

---

## 3. Gateway Proxy

### Proxying the OpenClaw UI
- As a **user**, I want to access the OpenClaw UI through `/gateway/...` paths so that the sandbox is accessible through the app's domain without exposing the sandbox URL directly.
- As a **user**, I want the proxy to inject the gateway token into HTML responses so that the OpenClaw UI can authenticate with its backend automatically.
- As a **user**, I want WebSocket URLs rewritten in proxied HTML so that real-time features (like terminal and chat) work through the proxy.
- As a **user**, I want the proxy to inject a heartbeat script that POSTs to `/api/status` periodically so that the sandbox timeout is extended while I'm actively using the UI.

### WebSocket Rewriting
- As a **user**, I want WebSocket connections targeting the proxy host transparently rewritten to connect to the sandbox directly so that real-time terminal and chat work seamlessly.
- As a **user**, I want the gateway token injected as a WebSocket sub-protocol (`openclaw.gateway-token.<token>`) so that the sandbox authenticates WebSocket connections without URL query params.
- As a **user**, I want the `?token=` query parameter stripped from the URL bar after initial handoff so that the token doesn't leak in browser history or referrer headers.

### Heartbeat & Timeout Extension
- As a **user**, I want the injected heartbeat script to send a keep-alive POST every 4 minutes only while WebSocket connections are open and the tab is visible so that the sandbox stays alive during active use without unnecessary traffic.
- As the **system**, I want the heartbeat to stop when the tab is hidden or all WebSockets close so that idle tabs don't keep the sandbox alive unnecessarily.

### Waiting Page
- As a **user**, I want to see a waiting page with status-specific labels ("Creating sandbox", "Installing OpenClaw", "Restoring snapshot", "Waiting for gateway") so that I understand what stage the startup is in.
- As a **user**, I want the waiting page to poll `/api/status?health=1` every 2 seconds and auto-redirect when the gateway reports ready so that I don't have to manually refresh.
- As a **user**, I want the waiting page to use a `<meta name="referrer" content="no-referrer">` tag so that the sandbox origin isn't leaked via HTTP referrer.

### Request Proxying
- As the **system**, I want all HTTP methods (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) proxied to the sandbox so that full REST APIs work through the gateway.
- As the **system**, I want query parameters preserved when proxying so that API calls with parameters work correctly.
- As the **system**, I want request bodies streamed to the sandbox so that large payloads don't buffer in memory.
- As the **system**, I want response status codes and safe headers preserved in proxy responses so that clients get correct responses.
- As the **system**, I want non-HTML responses (JSON, images, binary) passed through untouched so that only HTML gets injected.
- As the **system**, I want a 5-minute request timeout on proxied requests so that hung upstream requests don't block indefinitely.

### Header Security
- As the **system**, I want only safe request headers forwarded (accept, user-agent, content-type, etc.) and sensitive headers (cookie, authorization, origin, referer) blocked so that auth tokens and cookies aren't leaked to the sandbox.
- As the **system**, I want hop-by-hop headers stripped from proxied requests so that proxy compatibility is maintained.
- As the **system**, I want `Content-Security-Policy` headers injected into HTML responses so that the injected script can only talk to the sandbox and proxy origins.
- As the **system**, I want `X-Frame-Options: DENY` set on proxied responses so that the UI can't be embedded in external sites.
- As the **system**, I want `Referrer-Policy: no-referrer` set so that the sandbox origin isn't exposed to downstream services.

### Path Validation
- As the **system**, I want paths with null bytes rejected so that null-byte injection is prevented.
- As the **system**, I want encoded slashes (`%2f`, `%5c`) rejected so that path traversal is prevented.
- As the **system**, I want double-encoded sequences rejected so that encoding bypass attempts are blocked.
- As the **system**, I want paths with `.` or `..` segments rejected so that directory traversal is prevented.
- As the **system**, I want invalid UTF-8 in paths rejected so that malformed paths are caught.
- As the **system**, I want control characters in paths rejected so that malicious characters are filtered.
- As the **system**, I want `_`-prefixed and `token`/`authorization` query parameters stripped from proxied requests so that internal params and credentials aren't forwarded.

### Redirect Handling
- As the **system**, I want same-host redirects preserved in proxy responses so that internal navigation works.
- As the **system**, I want cross-host redirects blocked so that users aren't redirected to external sites.
- As the **system**, I want protocol-relative redirects (`//`) blocked so that open-redirect attacks are prevented.

### Error Recovery
- As the **system**, I want upstream fetch errors to return 502 Bad Gateway so that users know the issue is with the sandbox, not the app.
- As the **system**, I want a sandbox 410 Gone response to trigger automatic recovery (mark unavailable, re-ensure) so that reclaimed VMs are automatically recreated.

### Security
- As a **developer**, I want auth enforced before serving any proxied HTML containing the gateway token so that the token can't leak to unauthenticated users.
- As a **developer**, I want a `<base href="/gateway/">` tag injected into proxied HTML so that relative URLs resolve correctly through the proxy path.

---

## 4. Firewall

### Mode Management
- As an **admin**, I want to switch the firewall between "disabled", "learning", and "enforcing" modes using pill buttons so that I can control the security posture.
- As an **admin**, I want mode changes to take effect within 300ms so that the policy update is near-instant.

### Disabled Mode
- As an **admin**, I want the firewall in "disabled" mode to allow all outbound traffic so that there are no restrictions during initial setup or debugging.

### Learning Mode
- As an **admin**, I want the firewall in "learning" mode to observe and record all outbound domains accessed by the sandbox so that I can build an allowlist from real traffic.
- As an **admin**, I want to see a "Learning active" indicator with the last ingestion timestamp so that I know learning is working and when data was last collected.
- As the **system**, I want shell commands logged to `/tmp/shell-commands-for-learning.log` inside the sandbox so that domain learning can extract destinations from real usage.
- As the **system**, I want domains extracted from the log with their categories (npm, curl, git, dns, fetch, unknown) so that I can understand what traffic types are occurring.
- As an **admin**, I want to see each learned domain with its hit count and category tags so that I can assess which domains are actively used.
- As an **admin**, I want to filter/search learned domains when there are more than 3 so that I can find specific domains in a large list.

### Enforcing Mode
- As an **admin**, I want the firewall in "enforcing" mode to block all outbound traffic except domains on the allowlist so that the sandbox has a strict security boundary.
- As the **system**, I want the firewall policy applied to the sandbox via the Vercel Sandbox API so that enforcement happens at the network level.

### Allowlist Management
- As an **admin**, I want to manually add domains to the allowlist (comma or newline separated) so that I can pre-approve known-good destinations.
- As an **admin**, I want to remove individual domains from the allowlist (with confirmation dialog) so that I can revoke access to specific destinations.
- As an **admin**, I want to approve individual learned domains to the allowlist with one click so that I can selectively promote observed traffic.
- As an **admin**, I want to dismiss individual learned domains (with confirmation) so that I can clean up noise without approving.

### Promote Learned to Enforcing
- As an **admin**, I want to "Promote learned to enforcing" (with confirmation dialog) to add all learned domains to the allowlist and switch to enforcing mode in one action so that I can transition from learning to enforcement quickly.

### Block Test
- As an **admin**, I want to test whether a specific domain would be blocked or allowed by entering it in the "Block test" input so that I can verify the policy before relying on it.
- As an **admin**, I want to see the test result (Allowed/Blocked) with a reason so that I understand why a domain would be permitted or denied.

### Firewall Events
- As an **admin**, I want to see the 8 most recent firewall events (action, domain, category, decision, source command, timestamp) so that I can monitor real-time firewall activity.
- As an **admin**, I want each event to show whether it was "allowed" or "blocked" as a color-coded badge so that I can spot blocked traffic at a glance.
- As an **admin**, I want to see the source command that triggered a firewall event so that I can trace which process made the request.
- As an **admin**, I want to refresh the events list manually so that I can get the latest data on demand.

### Domain Normalization & Validation
- As the **system**, I want domain inputs normalized by stripping schemes, paths, usernames, and ports so that `https://api.openai.com/v1/chat` becomes `api.openai.com`.
- As the **system**, I want invalid domain formats rejected (IPs, single-label names, ambiguous TLDs like `.get`/`.js`, control characters, wildcards, >253 chars) so that the allowlist contains only valid FQDNs.
- As the **system**, I want Unicode domain separators (U+3002, U+FF0E, U+FF61) converted to ASCII dots and IDN domains converted to ASCII form so that international domains are normalized.
- As the **system**, I want domains extracted from multiple log patterns (URLs, host/DNS assignments, env vars, JS fetch/import/axios calls, bare domain names) so that learning covers diverse usage patterns.
- As the **system**, I want learned domains capped at 500 entries (by lastSeenAt) and firewall events capped at 200 entries so that metadata doesn't grow unbounded.

### Firewall Policy Sync
- As the **system**, I want the firewall policy immediately synced to the running sandbox after any mode or allowlist change so that enforcement is live without delay.
- As the **system**, I want policy sync skipped if the sandbox is stopped so that changes queue up for the next boot.
- As the **system**, I want a 502 error returned if sandbox policy sync fails after persisting a change so that the operator knows the change was saved but not yet applied.

### Learned Domains API
- As the **system**, I want a `DELETE /api/firewall/learned` endpoint so that dismissed domains are removed from the learned list without being added to the allowlist.
- As the **system**, I want a `GET /api/firewall/learned` endpoint so that the client can fetch the current learned domains.

---

## 5. Admin UI — General

### Navigation & Layout
- As an **admin**, I want a tabbed interface with Status, Firewall, Channels, Terminal, Logs, and Snapshots tabs so that I can navigate between different management areas.
- As an **admin**, I want the admin page to auto-refresh status every 5 seconds so that I always see current information without manual refreshing.
- As an **admin**, I want toast notifications for successful and failed actions so that I get immediate feedback on operations.
- As an **admin**, I want action buttons disabled while an operation is pending so that I can't accidentally trigger concurrent actions.

### Status Panel
- As an **admin**, I want to see a metrics grid with Sandbox ID, Snapshot, Auth mode, Store backend (with memory-only warning), Gateway readiness, and Firewall mode so that I have a complete overview.
- As an **admin**, I want a link to "Open gateway" that opens the proxied OpenClaw UI in a new tab so that I can quickly access the sandbox.

### Unauthenticated Landing
- As a **visitor**, I want to see a branded landing page with "VClaw Sandbox" title, a description of the app's purpose, a "Sign in with Vercel" button, and a "Health check" link so that I understand what the app is and how to get started.

---

## 6. Terminal (SSH Panel)

- As an **admin**, I want to execute shell commands inside the running sandbox from the Terminal tab so that I can inspect and debug the sandbox without direct SSH access.
- As an **admin**, I want to see suggested commands (Tail OpenClaw log, List logs, Tail sandbox logs, View config, Running processes, Disk usage, Memory info, Network listeners) so that I can quickly run common diagnostics.
- As an **admin**, I want my command history (last 5 commands) persisted in localStorage so that I can re-run recent commands easily.
- As an **admin**, I want to see stdout and stderr output for each command along with the exit code so that I can interpret results.
- As an **admin**, I want to copy command output to clipboard with a "Copy" button so that I can share or save diagnostic output.
- As an **admin**, I want the terminal disabled with an informative message when the sandbox is not running (different messages for starting, stopped, other states) so that I understand why I can't execute commands.
- As the **system**, I want commands limited to 2000 characters and 20 arguments, with output truncated to 64KB, so that the terminal can't be abused to overwhelm the server.

---

## 7. Logs Panel

- As an **admin**, I want to view real-time logs from the sandbox in the Logs tab so that I can monitor activity and debug issues.
- As an **admin**, I want to toggle live polling on/off so that I can pause the log stream when reviewing a specific entry.
- As an **admin**, I want logs polled every 3 seconds when live mode is on so that I see near-real-time updates.
- As an **admin**, I want to filter logs by level (error, warn, info, debug — debug off by default) so that I can focus on relevant severity.
- As an **admin**, I want to filter logs by source (lifecycle, proxy, firewall, channels, auth, system, or "all") so that I can isolate specific subsystems.
- As an **admin**, I want to search logs by text so that I can find specific messages.
- As an **admin**, I want virtual scrolling for large log sets so that the UI remains performant with many entries.
- As an **admin**, I want auto-scroll to the latest entry when live mode is on so that I see new logs as they arrive.
- As an **admin**, I want to copy individual log entries to clipboard so that I can share specific log lines.
- As an **admin**, I want contextual empty states (sandbox starting, stopped, error, uninitialized, no logs yet, no matching filters) so that I always know why the log panel is empty.
- As an **admin**, I want to see the count of filtered vs. total entries and a "refreshing..." indicator so that I know the data's scope and freshness.
- As the **system**, I want logs merged from both server-side ring buffer and sandbox log files (`/tmp/openclaw/openclaw-*.log`) so that the log panel shows the complete picture.
- As the **system**, I want sandbox log lines parsed as JSON (with fallback to plain text) so that structured and unstructured logs are both handled gracefully.

---

## 8. Channels — Slack

### Setup Wizard
- As an **admin**, I want a step-by-step wizard to connect Slack: (1) create a Slack app with pre-configured permissions via manifest, (2) paste credentials, (3) get the webhook URL so that the setup is guided and complete.
- As an **admin**, I want a "Create Slack App" button that opens Slack's app creation page with a pre-built manifest so that I don't have to manually configure OAuth scopes and event subscriptions.
- As an **admin**, I want to enter my Slack Signing Secret and Bot Token (xoxb-) via masked input fields (with show/hide toggle) so that credentials are entered securely.
- As an **admin**, I want bot token validation that checks for the `xoxb-` prefix so that I catch obvious mistakes before saving.

### Connection Testing
- As an **admin**, I want to click "Test Connection" after entering a valid bot token to verify it works (returns team name, user, botId) so that I can confirm the token is valid before saving.

### Connected State
- As an **admin**, I want to see the connected Slack workspace name, bot ID, webhook URL (with copy button), configured timestamp, and queue depth when connected so that I have full visibility into the integration.
- As an **admin**, I want to update credentials for an existing Slack connection so that I can rotate tokens without disconnecting.
- As an **admin**, I want to disconnect Slack (with confirmation dialog) so that I can remove the integration cleanly.
- As an **admin**, I want the webhook URL displayed prominently (with copy) so that I can paste it into Slack's Event Subscriptions configuration.

### Webhook Processing
- As a **Slack user**, I want to mention the bot in a channel and have my message forwarded to OpenClaw so that I can interact with the AI through Slack.
- As a **Slack user**, I want to receive threaded replies from OpenClaw in the same Slack thread so that conversations stay organized.
- As the **system**, I want Slack webhook requests validated using the signing secret so that forged requests are rejected.
- As the **system**, I want Slack messages enqueued for durable processing so that messages aren't lost if the sandbox is temporarily unavailable.

---

## 9. Channels — Telegram

### Setup Wizard
- As an **admin**, I want a step-by-step wizard to connect Telegram: (1) create a bot via @BotFather, (2) paste the bot token, (3) preview and save so that the setup is guided.
- As an **admin**, I want to enter the Telegram bot token via a masked input field (with show/hide toggle) so that credentials are entered securely.

### Preview & Connection
- As an **admin**, I want to click "Preview bot" to validate the token and see the bot's name and username so that I can confirm I have the right bot before saving.
- As an **admin**, I want to click "Save & Connect" to store the token and register the webhook with Telegram so that the bot starts receiving messages.

### Connected State
- As an **admin**, I want to see the connected bot username, webhook URL, queue depth, and connection status (connected, disconnected, error) when connected so that I have full visibility.
- As an **admin**, I want to update the bot token for an existing Telegram connection so that I can rotate tokens.
- As an **admin**, I want to disconnect Telegram (with confirmation dialog) so that I can remove the integration cleanly.
- As an **admin**, I want to see the last error message if the Telegram connection has issues so that I can diagnose problems.

### Webhook Processing
- As a **Telegram user**, I want to send a message to the bot and have it forwarded to OpenClaw so that I can interact with the AI through Telegram.
- As a **Telegram user**, I want to receive replies from OpenClaw in the same Telegram chat so that the conversation is seamless.
- As the **system**, I want Telegram webhook requests validated using webhook-secret verification so that forged requests are rejected.
- As the **system**, I want Telegram webhook secrets rotated gracefully with a `previousWebhookSecret` + expiry window so that in-flight requests during rotation aren't rejected.
- As the **system**, I want Telegram messages enqueued for durable processing so that messages aren't lost.

---

## 10. Channels — Discord

### Setup Wizard
- As an **admin**, I want a step-by-step wizard to connect Discord: (1) create a Discord app + bot, (2) copy the bot token, (3) paste and connect so that the setup is guided.
- As an **admin**, I want to enter the Discord bot token via a masked input field (with show/hide toggle) so that credentials are entered securely.

### Auto-Configuration Options
- As an **admin**, I want a checkbox to auto-configure the interactions endpoint URL so that I don't have to manually set it in the Discord Developer Portal.
- As an **admin**, I want a checkbox to auto-register the `/ask` slash command so that users can immediately interact with the bot.
- As an **admin**, I want a "Force overwrite existing endpoint" checkbox when updating credentials so that I can replace an existing endpoint configuration.

### Setup Progress
- As an **admin**, I want to see a multi-phase progress indicator (Validating → Saving → Configuring endpoint → Registering /ask) during setup so that I know what step the process is on.

### Connected State
- As an **admin**, I want to see a status checklist showing: token validated, interactions endpoint configured, /ask command registered, and bot invite link so that I have full visibility into the integration health.
- As an **admin**, I want to register the `/ask` command separately if it wasn't registered during initial setup so that I can add it later.
- As an **admin**, I want an "Invite bot" link to add the bot to a Discord server so that I can easily onboard new servers.
- As an **admin**, I want to see detailed Discord app info (Application ID, Public Key, Webhook URL) in an expandable details section so that I can reference these values when needed.
- As an **admin**, I want to copy any Discord detail (Application ID, Public Key, Webhook URL) to clipboard so that I can paste them elsewhere.
- As an **admin**, I want to see queue depth for pending Discord messages so that I know if messages are backed up.
- As an **admin**, I want to update the bot token for an existing Discord connection so that I can rotate tokens.
- As an **admin**, I want to disconnect Discord (with confirmation dialog) so that I can remove the integration cleanly.

### Interaction Processing
- As a **Discord user**, I want to use the `/ask` slash command to send a message to OpenClaw so that I can interact with the AI through Discord.
- As a **Discord user**, I want to receive a deferred response that updates with the AI's reply so that I get timely feedback even if processing takes time.
- As the **system**, I want Discord interaction requests validated using Ed25519 signature verification so that forged requests are rejected.
- As the **system**, I want Discord messages enqueued for durable processing so that messages aren't lost.

---

## 11. Channels — General

### Summary & Queue Monitoring
- As an **admin**, I want to see total queued messages and dead-letter counts across all channels in the Channels panel header so that I have an at-a-glance health indicator.
- As an **admin**, I want per-channel queue depth displayed when messages are pending so that I know which channel has backed-up traffic.
- As an **admin**, I want dead-letter counts displayed in red when messages have permanently failed so that I know messages were lost and need investigation.

### Cron-Based Queue Drain
- As an **operator**, I want a `/api/cron/drain-channels` endpoint that can be triggered by Vercel Cron Jobs to replay deferred queue work so that messages are processed even if the initial webhook handler couldn't complete.
- As an **operator**, I want the cron drain endpoint protected by `CRON_SECRET` verification so that only authorized callers can trigger it.
- As an **operator**, I want the cron drain endpoint callable via both GET and POST so that different cron services and integrations can trigger it.
- As an **operator**, I want non-production environments to skip cron secret verification so that local development doesn't require secret management.
- As an **operator**, I want the cron response to report success/failure status per channel so that I can verify all channels were processed.

### Sandbox Restoration on Message
- As the **system**, I want incoming channel messages to trigger sandbox restoration if it's stopped so that users get responses even after an idle period.

### Message Queue & Retry System
- As the **system**, I want channel messages enqueued as jobs with deduplication based on platform-specific identifiers so that duplicate webhooks don't result in duplicate AI responses.
- As the **system**, I want failed jobs retried with exponential backoff (up to 8 retries) so that transient errors are recovered without overwhelming services.
- As the **system**, I want custom retry-after delays from platform APIs respected so that rate limiting guidance is followed.
- As the **system**, I want jobs parked with a future attempt time in the queue so that scheduled retries don't block processing of other jobs.
- As the **system**, I want permanently failed jobs moved to dead-letter so that operators can investigate and resolve issues.
- As the **system**, I want a distributed lock acquired before draining the queue so that only one drain operation runs concurrently.
- As the **system**, I want stale leases in the processing queue recovered automatically so that jobs don't get stuck if a processor crashes.

### Session & Conversation History
- As the **system**, I want per-channel conversation history maintained by session key so that the AI can provide context-aware responses.
- As the **system**, I want session history trimmed to the most recent 20 entries so that memory usage is bounded.
- As the **system**, I want session history expired after 24 hours so that stale conversations don't occupy storage indefinitely.

### Message Processing
- As the **system**, I want bot messages and system events skipped during processing so that only user messages reach the AI.
- As the **system**, I want messages forwarded to the OpenClaw gateway via `/v1/chat/completions` with conversation history so that the AI has full context.
- As the **system**, I want reply content extracted including text and images (data URIs and markdown syntax) so that rich responses are sent back to users.
- As a **Discord user**, I want long AI responses automatically split into multiple messages so that Discord's 2000-character limit doesn't truncate responses.
- As a **Discord user**, I want a fallback mechanism where responses are posted as channel messages (with @mention) if the webhook interaction expires so that I still receive the AI response even if processing takes too long.
- As a **Telegram user**, I want to see a "typing" indicator while the AI is processing my message so that I know my request is being handled.

---

## 12. Health & Status

### Health Check
- As an **operator**, I want a `GET /api/health` endpoint that returns quickly without auth so that uptime monitors and load balancers can check liveness.
- As a **visitor**, I want a "Health check" link on the landing page so that I can quickly verify the app is responding.

### Status API
- As the **admin UI**, I want a `GET /api/status` endpoint that returns the full system state (auth mode, store backend, sandbox status, gateway readiness, firewall state, channel configs, user info) so that the frontend can render a complete dashboard.
- As the **system**, I want the status endpoint to optionally include a health probe of the gateway (`?health=1`) so that the UI can display accurate gateway readiness.
- As the **proxy**, I want a `POST /api/status` endpoint that the injected heartbeat script calls so that the sandbox timeout is extended while a user is actively viewing the gateway UI.

---

## 13. Store & Persistence

### Upstash (Production)
- As an **operator**, I want to use Upstash Redis as the store backend for production deployments so that metadata, firewall state, channel configs, and queues survive restarts.
- As an **operator**, I want distributed locking (with TTL and renewal) in Upstash so that concurrent requests don't corrupt state.

### Memory Store (Development)
- As a **developer**, I want a memory-backed store for local development so that I can work without Upstash credentials.
- As an **admin**, I want a "(memory only)" indicator on the status panel when using the memory store so that I know data won't persist across restarts.

### Metadata Schema
- As the **system**, I want `ensureMetaShape` to normalize and migrate metadata from any previous shape so that schema upgrades don't require manual intervention.
- As the **system**, I want the schema version tracked (`_schemaVersion`) so that future migrations can detect the current format.
- As the **system**, I want snapshot history capped at 50 entries so that the metadata record doesn't grow unbounded.

### Concurrency Control
- As the **system**, I want compare-and-swap (CAS) semantics with version numbers on metadata writes so that concurrent writes don't silently overwrite each other.
- As the **system**, I want Lua scripts used for atomic operations (CAS, lock renewal, queue operations) in Upstash so that race conditions are eliminated at the Redis level.

### Durable Queues
- As the **system**, I want webhook messages enqueued with visibility timeouts so that a processing failure re-queues the job for retry.
- As the **system**, I want queue items acknowledged explicitly after successful processing so that they're permanently removed.
- As the **system**, I want expired leases automatically re-queued so that crashed processors don't stall the queue forever.

### Production Safety
- As the **system**, I want an error thrown if production mode is detected without Upstash configured so that misconfigured deployments are caught at startup rather than silently losing data.

---

## 14. Environment & Configuration

- As an **operator**, I want environment variable configuration (via `.env.example` template) for: auth mode, session secret, Vercel OAuth client ID/secret, Vercel sandbox API token, Upstash Redis URL/token, AI Gateway credentials, and cron secret so that deployment is configurable without code changes.
- As an **operator**, I want the app to work with sensible defaults when optional variables are unset (e.g., deployment-protection auth mode, memory store) so that minimal configuration is needed for development.
- As a **developer**, I want `.env*.local` gitignored so that secrets are never committed.

---

## 15. Smoke Testing

- As an **operator**, I want to run `pnpm smoke:remote --base-url <url>` to execute a suite of health, status, gateway probe, firewall read, channel summary, and SSH echo checks against a deployment so that I can verify it's working.
- As an **operator**, I want safe read-only phases to run by default and destructive phases (ensure, snapshot, restore) gated behind `--destructive` so that I don't accidentally modify a production deployment.
- As an **operator**, I want structured JSON output (`--json-only`) and human-readable stderr progress so that I can integrate smoke tests into CI/CD or read output manually.
- As an **operator**, I want configurable timeouts (`--timeout`, `--request-timeout`) so that I can adapt to slow environments.
- As an **operator**, I want to pass auth cookies via `--auth-cookie` or `SMOKE_AUTH_COOKIE` env var for sign-in-with-vercel deployments so that smoke tests can authenticate.
- As an **operator**, I want the smoke runner to support Vercel deployment protection bypass (`VERCEL_AUTOMATION_BYPASS_SECRET`) so that automated testing can reach protected deployments.

---

## 16. OpenClaw Bootstrap & Configuration

- As the **system**, I want bootstrap to install the OpenClaw binary, write `openclaw.json` with the gateway config, write the gateway token file, and write the AI Gateway key file so that the sandbox is fully operational after creation.
- As the **system**, I want bootstrap to write a restore startup script that can be replayed on snapshot restore so that the sandbox boots correctly from any snapshot.
- As the **system**, I want bootstrap to install shell hooks for firewall learning so that outbound traffic can be observed.
- As the **system**, I want bootstrap to write a force-pair script so that the gateway doesn't require manual device pairing.
- As the **system**, I want bootstrap to write image generation skill and script files so that OpenClaw has image generation capabilities.
- As the **system**, I want the OpenClaw gateway config to include the AI Gateway base URL and proxy origin so that AI requests route through the AI Gateway and the proxy URLs are correct.

---

## 17. Loading & Transitions

- As a **user**, I want to see a loading state while the admin page fetches initial data so that I know the app is working even before content appears.
- As an **admin**, I want pending operations to show appropriate loading indicators (button text changes, disabled state) so that I know an action is in progress.
- As an **admin**, I want confirmation dialogs for destructive actions (stop, restore, disconnect, remove domain, dismiss domain, promote to enforcing) so that I can't accidentally trigger irreversible operations.

---

## 18. Developer Experience

- As a **developer**, I want to run `pnpm dev` for local development with hot reload so that I can iterate quickly.
- As a **developer**, I want to run `pnpm test` using `node:test` through `tsx --test` so that I can verify correctness.
- As a **developer**, I want `pnpm lint`, `pnpm typecheck`, and `pnpm build` as verification steps so that I can ensure code quality before deploying.
- As a **developer**, I want the codebase to use `cacheComponents: true` in Next.js config so that builds take advantage of component caching.
- As a **developer**, I want clear error messages when required environment variables are missing so that I can diagnose configuration issues quickly.
