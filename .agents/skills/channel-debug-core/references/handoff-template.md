# Channel Specialist Handoff: <channel>

## Scope

- Specialist:
- Channel:
- Task:
- Evidence artifact path:
- Files inspected:
- Files changed:

## Deployment-State Proof

- Local HEAD:
- Remote main:
- Deployed/runtime proof:
- Mismatch? yes/no/unknown:

## Readiness Triad

- route-ready:
- native-accepted:
- user-visible-reply:

## Required Admin Surfaces

- why-not-ready:
- channels summary:
- sandbox diag:
- admin logs:
- requestId / deliveryId followed:

## Runtime Path Diagram

```text
platform message -> app webhook route -> fast path? -> workflow? -> sandbox URL/port -> native handler -> platform reply
```

Mark each edge: `unknown`, `verified-good`, or `verified-bad`.

## Hypothesis Table

| Hypothesis | Evidence for | Evidence against | Fastest falsifier | Status |
|---|---|---|---|---|

## Terminal Path Audit

- Accepted path logs?
- Accepted path updates lastForward?
- Non-2xx path logs?
- Non-2xx path updates lastForward?
- Fetch/timeout path logs?
- Fetch/timeout path updates lastForward?
- Skipped/dedup/auth/invalid JSON path explains why?
- sandbox-not-listening refreshes stale port URL?

## Finding

- Verified bad edge:
- Root cause confidence:
- Why prior hypotheses were ruled out:

## Proposed Fix

- Minimal change:
- Shared-file ownership needed?
- Risk:

## Verification

- Automated:
- Manual:
- Before signal:
- After signal:

## Handoff / Escalation

- Needs parent decision:
- Needs another channel specialist:
- Do not proceed until:
