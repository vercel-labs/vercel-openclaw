# FAQ

## OpenClaw is currently pinned to {{OPENCLAW_VERSION}}. Why?

This project runs the latest verified OpenClaw release for Vercel Sandbox. The pinned version is the newest version verified against this deployment's install, sleep, wake, and resume flow.

## What does "verified" mean?

It means the release has been checked against the workflow that matters here: install, run, sleep, wake, and resume. That matters because a sandbox waking up is a lot like restarting OpenClaw on your Mac mini. The process may start, but if channels or history take too long to recover, the product feels broken.

## Why not just update to the newest release?

Recent upstream releases have introduced regressions in this flow. Examples include [#63225](https://github.com/openclaw/openclaw/issues/63225), which forced a rollback due to a missing dependency, and [#63863](https://github.com/openclaw/openclaw/issues/63863), where resume after wake became slow enough to disrupt Telegram and other channels. Until a release is verified here, it remains unverified for this deployment.

The pin moved from `openclaw@2026.4.11` to `openclaw@2026.4.12` alongside an app-layer fix for the Telegram wake stall. See the [post-mortem discussion](https://github.com/vercel-labs/vercel-openclaw/discussions/4) for the full root cause, timeline, and commits.

## How do I recover from a bad update?

To inspect the current sandbox:

```bash
npx sandbox connect <sandbox_id>
```

To preserve the current state before rollback:

```bash
npx sandbox snapshot <sandbox_id> --stop
```

To restore a known-good state:

```bash
npx sandbox snapshots list
npx sandbox create --snapshot <snapshot_id>
```

## Will this always require pinning?

The current plan is to keep using a pinned version until release coverage improves. We are working with the OpenClaw team on tests that exercise restart, sleep, wake, and resume behavior so these regressions are caught earlier.

## Find an issue?

If something looks wrong in `vercel-openclaw`, report it in the [issue tracker](https://github.com/vercel-labs/vercel-openclaw/issues). Include the pinned OpenClaw version, what you were doing, and any relevant admin logs or status details so the regression is easier to reproduce.

## I sent a message, the sandbox woke up, but nothing came back

The gateway boots in stages — it starts its HTTP server first, then initializes channels (Telegram, Slack, etc.) afterward. If your message hits the sandbox during that gap, it can get silently dropped. You'll see the sandbox status as "running" but the channel handler isn't actually listening yet.

To check, connect to the sandbox and run the built-in diagnostic:
```bash
npx sandbox connect <sandbox_id>
oc-diag
```

This checks the gateway process, port 3000, the Telegram handler on port 8787, Slack, AI Gateway connectivity, and the provider discovery configuration. Look for any `warn` or `fail` lines — they'll tell you exactly what's not ready yet.

You can also poke the Telegram handler directly:
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8787/telegram-webhook
```
- **401** means the handler is up (it's rejecting your missing secret — that's good)
- **200** with no body means the base server caught your request and threw it away
- **Connection refused** means the server hasn't started at all
