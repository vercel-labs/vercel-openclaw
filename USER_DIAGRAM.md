# System Flow Diagrams — vercel-openclaw

All major flows extracted from the codebase, rendered as Mermaid diagrams.

---

## 1. Authentication Flow

```mermaid
flowchart TD
    visitor([Visitor]) --> landing[Landing Page]
    landing --> |"Sign in with Vercel"| authMode{Auth Mode?}

    authMode --> |deployment-protection| dpAuth[Vercel Deployment Protection]
    dpAuth --> authed([Authenticated User])

    authMode --> |sign-in-with-vercel| authorize[GET /api/auth/authorize]
    authorize --> |Generate PKCE code_verifier + nonce| stateCookie[Encrypt OAuth state → cookie 5min TTL]
    stateCookie --> redirect[Redirect to Vercel OAuth]
    redirect --> vercelOAuth[Vercel OAuth Consent]
    vercelOAuth --> callback[GET /api/auth/callback]
    callback --> |Verify state + nonce, timing-safe compare| validateToken[Validate ID Token via JWKS]
    validateToken --> |Clear OAuth context cookie| session[Encrypt session → HttpOnly cookie 7d TTL]
    session --> |Redirect to ?next= destination| authed

    authed --> |Every request| checkSession{Session valid?}
    checkSession --> |Yes| checkExpiry{Token expiring?}
    checkExpiry --> |Yes| refreshToken[Refresh access token]
    refreshToken --> |Success| updateSession[Update session cookie]
    refreshToken --> |Failure| clearSession[Clear session → force re-login]
    checkExpiry --> |No| proceed([Proceed to app])
    updateSession --> proceed
    checkSession --> |No / 401| unauthorized[Return 401 + authorizeUrl]
    clearSession --> unauthorized

    authed --> |"Sign out"| signout[GET /api/auth/signout]
    signout --> clearAll[Clear session cookie]
    clearAll --> landing
```

---

## 2. Sandbox Lifecycle

```mermaid
stateDiagram-v2
    [*] --> uninitialized : First deploy

    uninitialized --> creating : Ensure running (no snapshot)
    uninitialized --> restoring : Ensure running (has snapshot)

    creating --> setup : Sandbox created, begin bootstrap
    setup --> running : Bootstrap complete, gateway ready

    stopped --> restoring : Ensure running / channel message
    restoring --> booting : Snapshot restored, startup script run
    booting --> running : Gateway probe succeeds (openclaw-app marker)

    running --> stopped : Snapshot & stop

    creating --> error : Bootstrap failure
    setup --> error : Bootstrap failure
    restoring --> error : Restore failure
    booting --> error : Gateway never ready (5min timeout)
    error --> creating : Ensure running (no snapshot)
    error --> restoring : Ensure running (has snapshot)

    running --> running : Extend timeout (every 30s)\nRefresh AI Gateway token (every 10m)

    note right of creating : Lifecycle lock (20min TTL, auto-renewed)\nStart lock prevents concurrent starts
    note right of error : Stale ops (>5min) auto-retried
```

---

## 3. Sandbox Creation & Bootstrap

```mermaid
flowchart TD
    ensure[Ensure Running] --> acquireLock[Acquire start lock]
    acquireLock --> |Lock acquired| checkState{Current status?}
    acquireLock --> |Contended| wait([Return waiting state])

    checkState --> |uninitialized / error, no snapshot| create[Create sandbox: 1 vCPU, 30min timeout, port 3000]
    checkState --> |stopped / error, has snapshot| restore[Create from snapshot]
    checkState --> |already running| done([Return running])

    create --> setCreating[Status → creating]
    setCreating --> installOC[Install openclaw binary globally]
    installOC --> writeConfig[Write openclaw.json: auth, port, AI model fallbacks]
    writeConfig --> writeToken[Write gateway token file]
    writeToken --> writeAIKey[Write AI Gateway key file]
    writeAIKey --> writeStartup[Write restore startup script]
    writeStartup --> writeSkills[Write image gen skill + force-pair script]
    writeSkills --> installHooks[Install shell hooks for firewall learning]
    installHooks --> setSetup[Status → setup]
    setSetup --> startGateway[Start OpenClaw gateway detached]
    startGateway --> probeReady{Probe gateway: openclaw-app marker?}
    probeReady --> |Yes| applyFW[Apply firewall policy]
    probeReady --> |No, retry 1s intervals, 5min max| probeReady
    probeReady --> |Timeout| setError[Status → error]
    applyFW --> setRunning[Status → running]

    restore --> setRestoring[Status → restoring]
    setRestoring --> createFromSnap[Create sandbox from snapshot ID]
    createFromSnap --> writeFreshToken[Write fresh AI Gateway token]
    writeFreshToken --> rewriteConfig[Re-write config, skills, force-pair script]
    rewriteConfig --> runStartup[Run restore startup script]
    runStartup --> forcePair[Force-pair device identity]
    forcePair --> setBooting[Status → booting]
    setBooting --> probeReady
```

---

## 4. Gateway Proxy Flow

```mermaid
flowchart TD
    browser([Browser]) --> |"GET /gateway/..."| proxyRoute[Gateway Route Handler]
    proxyRoute --> authCheck{Authenticated?}
    authCheck --> |No| return401[401 + authorizeUrl]
    authCheck --> |Yes| checkSandbox{Sandbox running?}

    checkSandbox --> |Not running| ensureStart[Ensure sandbox running via after]
    ensureStart --> waitingPage[Return waiting page HTML]
    waitingPage --> |Polls /api/status every 2s| pollStatus{Gateway ready?}
    pollStatus --> |No| waitingPage
    pollStatus --> |Yes| autoRedirect[Auto-redirect to /gateway]
    autoRedirect --> proxyRoute

    checkSandbox --> |Running| validatePath{Path valid?}
    validatePath --> |"Null bytes, .., encoded slashes, control chars"| reject[400 Bad Request]
    validatePath --> |Valid| buildRequest[Build proxy request]
    buildRequest --> |Strip sensitive headers: cookie, auth, origin, referer| filterHeaders[Filter safe headers only]
    filterHeaders --> |Strip _-prefixed & token query params| sanitizeQuery[Sanitize query params]
    sanitizeQuery --> |5min timeout| fetchUpstream[Fetch from sandbox]

    fetchUpstream --> |Error| err502[502 Bad Gateway]
    fetchUpstream --> |410 Gone| autoRecover[Mark unavailable → re-ensure]
    autoRecover --> waitingPage
    fetchUpstream --> |Redirect| checkRedirect{Same host?}
    checkRedirect --> |Yes| passRedirect[Pass redirect through]
    checkRedirect --> |No / protocol-relative| blockRedirect[Block redirect → error page]

    fetchUpstream --> |Success| checkContentType{HTML response?}
    checkContentType --> |No| passthrough[Pass response through unchanged]
    checkContentType --> |Yes| injectHTML[Inject into HTML]

    injectHTML --> injectBase["Add &lt;base href=/gateway/&gt;"]
    injectBase --> injectReferrer["Add meta referrer=no-referrer"]
    injectReferrer --> injectCSP[Add Content-Security-Policy]
    injectCSP --> injectXFrame[Add X-Frame-Options: DENY]
    injectXFrame --> injectScript[Inject interceptor script]

    injectScript --> tokenHandoff[Inject gateway token → URL, then strip from address bar]
    tokenHandoff --> wsRewrite[WebSocket URL rewriting: proxy host → sandbox host]
    wsRewrite --> wsAuth[Append gateway token as WS sub-protocol]
    wsAuth --> heartbeat[Heartbeat: POST /api/status every 4min while WS open + tab visible]
    heartbeat --> returnHTML([Return injected HTML])

    heartbeat --> |POST /api/status| touchSandbox[Extend sandbox timeout +15min]
```

---

## 5. Firewall Lifecycle

```mermaid
flowchart TD
    subgraph Modes
        disabled[Disabled: allow-all]
        learning[Learning: allow-all + observe]
        enforcing[Enforcing: allowlist only]
    end

    admin([Admin]) --> |Set mode| modeChange{Target mode?}
    modeChange --> disabled
    modeChange --> learning
    modeChange --> enforcing

    learning --> shellHooks[Shell hooks log commands to\n/tmp/shell-commands-for-learning.log]
    shellHooks --> ingest[Ingest log every 10s]
    ingest --> extractDomains[Extract domains from:\nURLs, env vars, DNS, fetch, import, curl]
    extractDomains --> normalize[Normalize: strip scheme/path/port,\nIDN → ASCII, Unicode separators → dots]
    normalize --> validate{Valid FQDN?}
    validate --> |"No: IPs, single-label, >.253 chars"| discard[Discard]
    validate --> |Yes| categorize[Categorize: npm/curl/git/dns/fetch/unknown]
    categorize --> dedup[Dedup: update hitCount, firstSeen, lastSeen]
    dedup --> store[Store learned domain\nCap at 500 entries]
    store --> emitEvent[Emit domain_observed event\nCap at 200 events]

    admin --> |Approve domain| addAllowlist[Add to allowlist + remove from learned]
    admin --> |Dismiss domain| dismissLearned[Remove from learned list]
    admin --> |Promote all| promoteAll[Move all learned → allowlist + set enforcing]
    admin --> |Add manually| manualAdd[Add comma/newline-separated domains]
    admin --> |Remove from allowlist| removeAllowlist[Remove domain from allowlist]
    admin --> |Block test| testDomain[POST /api/firewall/test → allowed/blocked + reason]

    addAllowlist --> syncPolicy[Sync policy to sandbox]
    manualAdd --> syncPolicy
    removeAllowlist --> syncPolicy
    promoteAll --> syncPolicy
    modeChange --> syncPolicy

    syncPolicy --> |Sandbox running| applyPolicy[sandbox.updateNetworkPolicy]
    syncPolicy --> |Sandbox stopped| queueForBoot[Applied on next boot]
    applyPolicy --> |disabled/learning| allowAll["Policy: allow-all"]
    applyPolicy --> |enforcing| allowOnly["Policy: { allow: [...sorted domains] }"]
```

---

## 6. Channel Message Flow

```mermaid
flowchart TD
    subgraph "Webhook Entry Points"
        slackWH[POST /api/channels/slack/webhook]
        telegramWH[POST /api/channels/telegram/webhook]
        discordWH[POST /api/channels/discord/webhook]
    end

    slackWH --> |Verify signing secret| slackValidate{Valid?}
    telegramWH --> |Verify webhook secret\n+ previous secret grace period| telegramValidate{Valid?}
    discordWH --> |Verify Ed25519 signature| discordValidate{Valid?}

    slackValidate --> |No| reject1[401 Rejected]
    telegramValidate --> |No| reject2[401 Rejected]
    discordValidate --> |No| reject3[401 Rejected]

    slackValidate --> |Yes| extractSlack[Extract message text + thread ID]
    telegramValidate --> |Yes| extractTelegram[Extract message text + chat ID]
    discordValidate --> |Yes| extractDiscord[Extract /ask prompt + interaction token]

    extractSlack --> skipBots{Bot message?}
    extractTelegram --> skipBots
    extractDiscord --> enqueue

    skipBots --> |Yes| ignore[Skip processing]
    skipBots --> |No| enqueue[Enqueue job with dedup key]

    enqueue --> ackWebhook([200 OK / ACK immediately])

    subgraph "Queue Processing"
        drain[Drain queue\nAcquire distributed lock]
        drain --> lease[Lease job with visibility timeout]
        lease --> checkSandbox{Sandbox running?}
        checkSandbox --> |No| ensureRestore[Ensure sandbox → restore/create]
        ensureRestore --> waitReady[Wait for gateway ready]
        waitReady --> checkSandbox
        checkSandbox --> |Yes| loadHistory[Load session history\n≤20 entries, 24h expiry]
        loadHistory --> buildPayload[Build /v1/chat/completions payload\nwith conversation context]
        buildPayload --> callGateway[POST to OpenClaw gateway]
        callGateway --> extractReply[Extract reply: text + images]
    end

    extractReply --> routeReply{Platform?}

    routeReply --> |Slack| slackReply[Post threaded reply via Bot API]
    routeReply --> |Telegram| telegramReply[Send reply via Bot API\nwith typing indicator]
    routeReply --> |Discord| discordReply{Interaction still valid?}
    discordReply --> |Yes| editInteraction[Edit deferred interaction response]
    discordReply --> |No / expired| fallbackPost[Post as channel message\nwith @mention to user]
    editInteraction --> splitCheck{Response > 2000 chars?}
    splitCheck --> |Yes| splitMessages[Split into multiple messages]
    splitCheck --> |No| sendSingle[Send single message]
    fallbackPost --> splitCheck

    slackReply --> saveHistory[Save to session history]
    telegramReply --> saveHistory
    splitMessages --> saveHistory
    sendSingle --> saveHistory
    saveHistory --> ackJob[Acknowledge job → remove from queue]

    callGateway --> |Transient error| retry[Retry with exponential backoff\nUp to 8 retries]
    retry --> |Exhausted| deadLetter[Move to dead-letter queue]

    subgraph "Cron Drain"
        cron["/api/cron/drain-channels\n(GET or POST)"]
        cron --> verifyCron{CRON_SECRET valid?\nSkip in non-prod}
        verifyCron --> |Yes| drainAll[Drain all channel queues]
        verifyCron --> |No| reject4[401 Rejected]
        drainAll --> drain
    end
```

---

## 7. Channel Configuration Flow

```mermaid
flowchart TD
    subgraph "Slack Setup"
        slackStart([Admin: Channels → Slack]) --> slackConfigured{Already connected?}
        slackConfigured --> |No| slackWizard[Step 1: Create Slack App via manifest]
        slackWizard --> slackCreds[Step 2: Paste Signing Secret + Bot Token xoxb-]
        slackCreds --> slackTest[Test Connection → team, user, botId]
        slackTest --> slackSave[Save credentials]
        slackSave --> slackWebhook[Step 3: Copy webhook URL → Slack Event Subscriptions]
        slackConfigured --> |Yes| slackView[View: workspace, botId, webhook URL, queue depth]
        slackView --> slackUpdate[Update credentials]
        slackView --> slackDisconnect[Disconnect with confirmation]
    end

    subgraph "Telegram Setup"
        tgStart([Admin: Channels → Telegram]) --> tgConfigured{Already connected?}
        tgConfigured --> |No| tgWizard[Step 1: Create bot via @BotFather]
        tgWizard --> tgToken[Step 2: Paste bot token]
        tgToken --> tgPreview[Preview bot → name, username]
        tgPreview --> tgSave[Save & Connect → register webhook + generate secret]
        tgConfigured --> |Yes| tgView[View: bot username, webhook URL, status, queue]
        tgView --> tgUpdate[Update token]
        tgView --> tgDisconnect[Disconnect with confirmation]
    end

    subgraph "Discord Setup"
        dcStart([Admin: Channels → Discord]) --> dcConfigured{Already connected?}
        dcConfigured --> |No| dcWizard[Step 1: Create app in Developer Portal]
        dcWizard --> dcToken[Step 2: Paste bot token]
        dcToken --> dcOptions["Options:\n☑ Auto-configure endpoint\n☑ Register /ask command\n☐ Force overwrite endpoint"]
        dcOptions --> dcConnect[Connect → multi-phase progress:\nValidating → Saving → Endpoint → /ask]
        dcConfigured --> |Yes| dcView["Checklist:\n✓ Token validated\n✓ Endpoint configured\n✓ /ask registered\n✓ Bot invite URL"]
        dcView --> dcRegister[Register /ask command separately]
        dcView --> dcInvite[Invite bot to server]
        dcView --> dcDetails["Details: App ID, Public Key, Webhook URL (copyable)"]
        dcView --> dcUpdate[Update token]
        dcView --> dcDisconnect[Disconnect with confirmation]
    end
```

---

## 8. Admin UI Navigation & Status Polling

```mermaid
flowchart TD
    user([User]) --> loadPage[Load admin page]
    loadPage --> fetchStatus[GET /api/status?health=1]

    fetchStatus --> |401| showLanding[Show landing page:\nSign in with Vercel + Health check]
    fetchStatus --> |200| showAdmin[Show admin shell with tabs]

    showAdmin --> autoRefresh[Auto-refresh every 5s]
    autoRefresh --> fetchStatus

    showAdmin --> tabs{Active Tab}

    tabs --> statusTab["Status Panel:\n• Sandbox ID, Snapshot ID\n• Auth mode, Store backend\n• Gateway readiness, Firewall mode\n• Last error banner\n• Ensure running / Open gateway\n• Snapshot & stop / Snapshot now"]

    tabs --> firewallTab["Firewall Panel:\n• Mode pills: disabled / learning / enforcing\n• Learning active indicator\n• Block test input\n• Approve domains textarea\n• Promote learned to enforcing\n• Allowlist (remove each)\n• Learned domains (approve/dismiss each)\n• Recent events (8 most recent)"]

    tabs --> channelsTab["Channels Panel:\n• Total queued + dead-letter badges\n• Slack / Telegram / Discord sub-panels\n• Per-channel config, status, queue depth"]

    tabs --> terminalTab["Terminal Panel:\n• Command input + Run button\n• Suggested commands (8 presets)\n• Command history (5, localStorage)\n• stdout / stderr + exit code\n• Copy output button\n• Disabled when not running"]

    tabs --> logsTab["Logs Panel:\n• Live/Paused toggle (3s poll)\n• Level filter: error, warn, info, debug\n• Source filter: lifecycle, proxy, firewall,\n  channels, auth, system\n• Text search\n• Virtual scrolling, auto-scroll\n• Copy individual entries\n• Contextual empty states"]

    tabs --> snapshotsTab["Snapshots Panel:\n• Take snapshot button\n• Current snapshot ID\n• History list: ID, timestamp, reason\n• Current / Available badges\n• Restore button (with confirmation)"]

    statusTab --> |Action| runAction[POST to API endpoint]
    runAction --> |Success| toast[Toast: success message]
    runAction --> |Failure| toastError[Toast: error message]
    runAction --> autoRefresh
```

---

## 9. Store & Persistence Architecture

```mermaid
flowchart TD
    subgraph "Store Selection"
        checkEnv{Production?\nVERCEL=1 or NODE_ENV=production}
        checkEnv --> |Yes| checkUpstash{Upstash configured?}
        checkUpstash --> |Yes| upstash[(Upstash Redis)]
        checkUpstash --> |No| crash[Throw error:\nmisconfigured deployment]
        checkEnv --> |No| memory[(In-Memory Store)]
    end

    subgraph "Operations"
        meta[Metadata CRUD\nCAS with version numbers]
        locks[Distributed Locks\nTTL + auto-renewal]
        queues[Durable Queues\nEnqueue, lease, ack, dead-letter]
        kv[Key-Value\nGet, set, delete with optional TTL]
    end

    upstash --> |Lua scripts for atomicity| meta
    upstash --> locks
    upstash --> queues
    upstash --> kv

    memory --> |Identical semantics| meta
    memory --> locks
    memory --> queues
    memory --> kv

    subgraph "Metadata Document (single record)"
        metaDoc["SingleMeta (_schemaVersion: 2)\n─────────────────────\n• sandboxId, snapshotId\n• status, gatewayToken\n• portUrls, startupScript\n• lastError, lastAccessedAt\n• firewall: mode, allowlist,\n  learned (500 cap), events (200 cap)\n• channels: slack, telegram, discord\n• snapshotHistory (50 cap)\n• version (CAS counter)"]
    end

    meta --> metaDoc
    meta --> |ensureMetaShape| migrate[Normalize & migrate\nfrom any prior schema]
```

---

## 10. End-to-End: First Visit to AI Response

```mermaid
sequenceDiagram
    actor User
    participant App as Admin UI
    participant API as API Routes
    participant Store as Store (Upstash/Memory)
    participant Sandbox as Vercel Sandbox
    participant OC as OpenClaw Gateway

    User->>App: Visit /
    App->>API: GET /api/status
    API-->>App: 401 (not authenticated)
    App-->>User: Landing page: "Sign in with Vercel"

    User->>API: Click sign in → /api/auth/authorize
    API-->>User: Redirect to Vercel OAuth
    User->>API: OAuth callback with code
    API->>API: Validate PKCE, verify ID token
    API-->>User: Set session cookie, redirect to /

    User->>App: Visit / (authenticated)
    App->>API: GET /api/status?health=1
    API->>Store: Read metadata
    Store-->>API: status: uninitialized
    API-->>App: Full status payload

    User->>App: Click "Ensure running"
    App->>API: POST /api/admin/ensure
    API->>Store: Acquire start lock
    API->>Store: Set status → creating
    API->>Sandbox: Create sandbox (1 vCPU, port 3000)
    API->>Sandbox: Install openclaw, write config, token, scripts
    API->>Sandbox: Start gateway
    API->>Sandbox: Probe for openclaw-app marker
    Sandbox-->>API: Gateway ready
    API->>Sandbox: Apply firewall policy
    API->>Store: Set status → running
    API-->>App: 200 OK

    User->>App: Click "Open gateway"
    App->>API: GET /gateway/
    API->>API: Verify auth
    API->>Sandbox: Proxy request
    Sandbox-->>API: HTML response
    API->>API: Inject token, WS rewrite, heartbeat, CSP
    API-->>User: Injected HTML

    User->>OC: Use OpenClaw UI (via proxy)
    OC-->>User: AI responses

    Note over User,OC: Meanwhile, from Slack:

    participant Slack as Slack
    Slack->>API: POST /api/channels/slack/webhook
    API->>API: Verify signing secret
    API->>Store: Enqueue message (dedup)
    API-->>Slack: 200 OK
    API->>Store: Drain queue (acquire lock)
    API->>Store: Load session history
    API->>Sandbox: POST /v1/chat/completions
    Sandbox-->>API: AI response
    API->>Slack: Post threaded reply
    API->>Store: Save session history
    API->>Store: Acknowledge job
```

---

## 11. Smoke Testing Flow

```mermaid
flowchart TD
    operator([Operator]) --> |"pnpm smoke:remote --base-url URL"| runner[Smoke Runner]

    runner --> safePhases["Safe phases (always run)"]
    safePhases --> health[health: GET /api/health]
    safePhases --> status[status: GET /api/status]
    safePhases --> probe[gatewayProbe: check gateway readiness]
    safePhases --> fwRead[firewallRead: GET /api/firewall]
    safePhases --> chanSummary[channelsSummary: GET /api/channels/summary]
    safePhases --> sshEcho[sshEcho: POST /api/admin/ssh echo test]

    runner --> |"--destructive flag"| destructivePhases["Destructive phases (opt-in)"]
    destructivePhases --> ensureRunning[ensureRunning: POST /api/admin/ensure]
    destructivePhases --> snapshotStop[snapshotStop: POST /api/admin/stop]
    destructivePhases --> restoreSnap[restoreFromSnapshot: POST /api/admin/snapshots/restore]

    runner --> |"--auth-cookie / SMOKE_AUTH_COOKIE"| authHeader[Attach auth cookie]
    runner --> |"VERCEL_AUTOMATION_BYPASS_SECRET"| bypassHeader[Attach bypass header]

    health --> report["JSON report to stdout:\n{ schemaVersion: 1, passed, phases, totalMs }"]
    sshEcho --> report
    ensureRunning --> report
    restoreSnap --> report

    report --> |"--json-only"| jsonOnly[Suppress stderr, JSON only]
    report --> |default| humanReadable[Human-readable stderr + JSON stdout]
    report --> exitCode{"All passed?"}
    exitCode --> |Yes| exit0[Exit 0]
    exitCode --> |No| exit1[Exit 1]
```
