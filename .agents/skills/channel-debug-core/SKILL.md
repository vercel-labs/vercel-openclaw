---
name: channel-debug-core
description: Channel webhook triage for vercel-openclaw Slack/Telegram/Discord/WhatsApp issues: prove deployment state, collect admin readiness endpoints, build evidence-first handoff before fixes.
---

# Channel Debug Core

Use this skill for any Slack, Telegram, Discord, or WhatsApp delivery issue.

## Non-Negotiables

Before proposing a fix, produce:

1. Deployment-state proof.
2. Runtime path diagram with each edge marked `unknown`, `verified-good`, or `verified-bad`.
3. Hypothesis table with fastest falsifier and status.
4. Channel Specialist Handoff.

Do not write "most likely" twice. Gather direct evidence.

## Required Admin Surfaces

Collect these first:

```bash
GET /api/admin/why-not-ready
GET /api/channels/summary
GET /api/admin/sandbox-diag
GET /api/admin/logs
```

Save the raw JSON before continuing. Logs are a ring buffer and can evict important events.

## Readiness Triad

Report these separately:

- `route-ready`: platform route/native route appears registered.
- `native-accepted`: `lastForward.ok` true with `classification:"accepted"`, or equivalent handler acceptance evidence.
- `user-visible-reply`: real user saw a Slack/Telegram/Discord/WhatsApp reply or status update.

Never collapse these into `connected`.

## Deployment Proof

Run or request equivalent evidence:

```bash
git rev-parse HEAD
git ls-remote origin main
curl "$URL/api/admin/sandbox-diag"
```

If the deployed runtime cannot be tied to the source being read, say so and stop code-level conclusions.

## Evidence Artifact Rule

Write evidence under:

```text
.agent-runs/channel-debug/<timestamp>/<channel>/
```

Do not commit runtime evidence. Redact admin secrets, bypass secrets, bot tokens, webhook secrets, and platform access tokens.

## Fallback When Live Access Is Unavailable

If you cannot call the deployed endpoints, produce a static code-path audit and mark runtime edges `unknown`. Do not claim runtime behavior from code alone.
