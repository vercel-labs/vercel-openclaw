# Vercel Connect as the Slack ingress

Research date: 2026-08-13. Sources are current local Vercel/eve source and first-party Vercel documentation.

## Conclusion

The proposed outer architecture is correct:

```text
Slack -> Vercel Connect -> protected Vercel host -> wake/route -> OpenClaw sandbox
```

Vercel Connect should own the Slack app, signing secret, webhook verification, and trigger delivery. The host should accept only Connect's destination-project OIDC identity, wake the sandbox, and pass a trusted event across a host-to-sandbox boundary. This matches eve's Slack setup and avoids storing `SLACK_SIGNING_SECRET` or a long-lived `SLACK_BOT_TOKEN` in the project.

It is **not a CLI-only substitution for the current implementation**. The present host verifies Slack HMAC headers and forwards them to OpenClaw's native `/slack/events` endpoint. Connect verifies Slack itself and re-attests the forwarded request with Vercel OIDC; the current Slack driver does not forward the original Slack signature headers. The host and the sandbox ingress therefore need an adapter boundary rather than transparent pass-through.

## What Connect provides

- `vercel connect create slack --name <name> --triggers` creates and installs a Connect-managed Slack app; `vercel connect attach <uid> --project <project> --environment production --triggers --trigger-path <path>` authorizes the project/environment and registers its HTTP receiver. Both `--triggers` uses matter. See the [Connect trigger documentation](https://vercel.com/docs/connect/concepts/triggers) and local CLI source at `/Users/qua/vercel/vercel/packages/cli/src/commands/connex/create.ts:166-225` and `attach.ts:241-348,460-468`.
- Connect receives the provider webhook, verifies its signature, resolves the configured project/environment domain, and forwards the body to that destination. Officially, trigger forwarding is Slack-only in beta and permits up to three destinations. See [Triggers](https://vercel.com/docs/connect/concepts/triggers).
- Current forwarding mints an OIDC token for the **destination project and environment**, then sends it as `Authorization: Bearer`, `x-vercel-oidc-token`, and `x-vercel-trusted-oidc-idp-token`. That last header is the protected-deployment path: Vercel documents that same-project OIDC is accepted by default, while other callers require a Trusted Sources rule. See `/Users/qua/vercel/core/api/packages/connex/src/connex-trigger.ts:505-600` and [Trusted Sources for Deployment Protection](https://vercel.com/changelog/trusted-sources-for-deployment-protection).
- Outbound Slack access comes from `@vercel/connect` at runtime. The SDK presents the deployment's Vercel OIDC identity to Connect and receives the connector token; it does not require a stored Slack token. See `/Users/qua/vercel/vercel/packages/connect/src/token.ts:147-203` and [Introducing Vercel Connect](https://vercel.com/blog/introducing-vercel-connect#the-app-proves-its-identity-with-oidc).

## How eve does it

eve registers Connect's trigger destination at `/eve/v1/slack`, then defines its Slack channel with:

```ts
credentials: connectSlackCredentials("slack/my-agent")
```

`connectSlackCredentials` returns two dynamic pieces: a function-form bot token backed by `getToken(..., { subject: { type: "app" } })`, and a `vercelOidc()` webhook verifier. The channel therefore refreshes outbound credentials at use time and verifies Connect's inbound OIDC instead of Slack HMAC. Sources:

- `/Users/qua/vercel/eve/docs/channels/slack.mdx:7-41`
- `/Users/qua/vercel/vercel/packages/connect/src/eve/slack-credentials.ts:20-63`
- `/Users/qua/vercel/eve/packages/eve/src/public/channels/auth.ts:753-883,991-1013`
- [Official eve Slack exercise](https://vercel.com/academy/building-agents-with-eve/add-slack)

The eve setup code also deliberately detaches the pathless/default destination and reattaches the connector at the channel route: `/Users/qua/vercel/eve/packages/eve/src/setup/connect-provisioning.ts:26-60`.

## Why the current host cannot use it unchanged

1. The host requires `SLACK_SIGNING_SECRET` and rejects requests without `x-slack-signature` and `x-slack-request-timestamp`: [`host/app/api/webhook/[channel]/route.ts`](../host/app/api/webhook/%5Bchannel%5D/route.ts), lines 83-86 and 160-195.
2. It forwards those same native Slack headers to OpenClaw `/slack/events`: the same file, lines 29-47 and 120-126.
3. Connect's Slack driver verifies those headers at intake but exposes no Slack `getForwardHeaders` hook; generic forwarding adds content type and the OIDC/trigger headers. See `/Users/qua/vercel/core/api/packages/connex/src/client-types/slack/client-driver.ts:84-88,571-617` and `/Users/qua/vercel/core/api/packages/connex/src/connex-trigger.ts:284-303,585-597`.
4. The host has no `@vercel/connect` dependency, and gateway startup passes only `OPENCLAW_GATEWAY_TOKEN` into the sandbox: [`host/package.json`](../host/package.json) and [`host/lib/wake.ts`](../host/lib/wake.ts), lines 111-129.

Therefore, Connect will securely reach a protected host, but the host cannot forward that request unchanged into an endpoint that insists on Slack's native signature.

## Recommended integration boundary

1. Create one Connect-managed Slack connector for production with triggers enabled; attach it to `vercel-openclaw` production at an explicit host path such as `/api/webhook/slack-connect`.
2. In that route, verify the Connect OIDC token (and destination project/environment) **before** recording activity or waking Sandbox. Keep Deployment Protection enabled; Connect's project-scoped trusted OIDC is the intended machine-to-machine bypass.
3. Acknowledge Slack promptly and enqueue/deduplicate before the roughly ten-second wake. eve follows this pattern: its Slack route returns `200` first and puts dispatch under `waitUntil` (`/Users/qua/vercel/eve/packages/eve/src/public/channels/slack/slackChannel.ts:826-985`). Connect retries destination `500`, `502`, `503`, and `504` responses up to three times, so event-id idempotency remains required. See [Triggers: Errors](https://vercel.com/docs/connect/concepts/triggers#errors).
4. Replace native-signature pass-through with one explicit adapter. Two viable designs need a prototype against the pinned OpenClaw image:
   - **Smaller native-OpenClaw bridge:** after OIDC verification, preserve the raw Slack body but create a fresh `x-slack-request-timestamp` and HMAC with a separate host-to-sandbox forwarding secret configured as OpenClaw's Slack signing secret. Resolve the Connect app token at wake and supply it to OpenClaw. This preserves OpenClaw's Slack plugin, but token expiry/refresh must become part of the sandbox lifecycle; a one-time token injected at boot is not the Connect per-use refresh model.
   - **Host-side Slack adapter:** the host uses `@vercel/connect` for an app token, translates the event into an authenticated OpenClaw gateway turn, and posts/updates Slack replies itself. This keeps Connect/OIDC and rotating Slack credentials in the Vercel deployment, where project identity is native, but recreates more of OpenClaw's native Slack behavior in the host.
5. Preserve the gateway token on the host-to-sandbox hop; do not forward Connect's deployment OIDC token to the sandbox's publicly routable port as its sole authorization boundary.

## Product-surface caveat

eve's current Connect Slack channel is mention/DM oriented. Its docs state that slash commands do not reach `onEvent` (`/Users/qua/vercel/eve/docs/channels/slack.mdx:181`), and the current managed Slack manifest builder configures Event Subscriptions and Interactivity but no `slash_commands` feature (`/Users/qua/vercel/core/api/packages/connex/src/client-types/slack/managed-create.ts:781-864`). Do not assume the manually-created `/openclaw` command transfers to a Connect-managed app. Start with `@OpenClaw` mentions and DMs, or separately design and verify slash-command support.

Switching connectors creates a new Slack app installation. Once the Connect path is working, uninstall the manually-created/stale Slack app to avoid duplicate bot identities; Vercel's [eve Slack exercise](https://vercel.com/academy/building-agents-with-eve/add-slack) calls out this cleanup behavior.
