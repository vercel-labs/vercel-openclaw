# Deployment Protection and Webhooks

`VERCEL_AUTOMATION_BYPASS_SECRET` is diagnostic-only: missing it does not fail preflight by itself, but protected third-party webhooks can be blocked before app auth runs.

## Channel behavior

- Slack webhook URLs include the bypass query parameter when the secret is configured.
- Telegram intentionally does not include the bypass query parameter. Telegram validates via the `x-telegram-bot-api-secret-token` header, and adding the bypass query parameter can cause `setWebhook` to silently drop registration. On protected deployments, Telegram needs a Deployment Protection Exception or another protection-compatible path.

## Delivery URLs vs operator-visible URLs

These are intentionally different surfaces:

- Slack delivery URLs may include `x-vercel-protection-bypass` when `VERCEL_AUTOMATION_BYPASS_SECRET` is configured.
- Telegram intentionally does not include the bypass query parameter because Telegram webhook registration can silently fail when it is present.
- Admin-visible payloads, rendered UI, connectability output, and docs examples must use display URLs that never expose the bypass secret.

Examples:

```
Delivery URL (Slack):    https://app.example.com/api/channels/slack/webhook?x-vercel-protection-bypass=[redacted]
Display URL (Slack):     https://app.example.com/api/channels/slack/webhook
Delivery URL (Telegram): https://app.example.com/api/channels/telegram/webhook
Display URL (Telegram):  https://app.example.com/api/channels/telegram/webhook
```

In code: use `buildPublicUrl()` only for outbound delivery or registration URLs that may need the bypass secret. Use `buildPublicDisplayUrl()` for admin JSON, UI, diagnostics, docs examples, and any operator-visible surface.

Reachability and readiness are different things.

- **Deployment Protection** decides whether Slack or Telegram can reach the app at all.
- **Preflight** tells you whether the deployment is configured well enough to expose those webhooks.
- **Safe launch verification** proves queue delivery, sandbox boot or resume, and a real completion.
- **Destructive launch verification** adds wake-from-sleep and resume-target preparation.

Run destructive launch verification before treating Slack or Telegram as ready for real traffic. A deployment is channel-ready only after destructive launch verification passes and `channelReadiness.ready` is `true`.

For the full channel setup and readiness guide, see [Channels and Webhooks](channels-and-webhooks.md).
