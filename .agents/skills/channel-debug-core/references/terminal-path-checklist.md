# Terminal Path Checklist

For webhook route changes, enumerate every terminal branch.

Must log:

- accepted webhook
- invalid signature / missing credentials
- invalid JSON
- dedup skip
- bot/self-message skip
- fast-path skipped with structured reason
- fast-path success
- fast-path non-2xx
- fast-path fetch exception / timeout
- boot message sent/failed
- workflow started
- workflow start failed
- unexpected failure

Must update `lastForward` for delivery attempts:

- fast-path success
- fast-path non-2xx
- fast-path fetch exception / timeout
- workflow native forward success/failure via shared workflow

Must classify:

- `sandbox-not-listening`
- `proxy-error`
- `handler-not-ready`
- `handler-error`
- `fetch-exception`
- `accepted`
- `exhausted`

Must refresh stale port URL:

- `sandbox-not-listening`, exactly once per request.
