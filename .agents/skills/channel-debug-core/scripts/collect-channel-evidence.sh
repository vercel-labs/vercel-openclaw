#!/usr/bin/env bash
set -euo pipefail

: "${URL:?Set URL=https://deployment.example}"
: "${ADMIN:?Set ADMIN to admin bearer token}"

CHANNEL="${CHANNEL:-all}"
OUT="${OUT:-.agent-runs/channel-debug/$(date -u +%Y%m%dT%H%M%SZ)/$CHANNEL}"
mkdir -p "$OUT"

headers=(-H "Authorization: Bearer $ADMIN")
if [[ -n "${BYPASS:-}" ]]; then
  headers+=(-H "x-vercel-protection-bypass: $BYPASS")
fi

git rev-parse HEAD > "$OUT/local-head.txt" 2>&1 || true
git ls-remote origin main > "$OUT/origin-main.txt" 2>&1 || true

curl -fsS "${headers[@]}" "$URL/api/admin/why-not-ready" > "$OUT/why-not-ready.json"
curl -fsS "${headers[@]}" "$URL/api/channels/summary" > "$OUT/channels-summary.json"
curl -fsS "${headers[@]}" "$URL/api/admin/sandbox-diag" > "$OUT/sandbox-diag.json"
curl -fsS "${headers[@]}" "$URL/api/admin/logs" > "$OUT/admin-logs.json"

jq . "$OUT/why-not-ready.json" > "$OUT/why-not-ready.pretty.json" || true
jq . "$OUT/channels-summary.json" > "$OUT/channels-summary.pretty.json" || true
jq . "$OUT/sandbox-diag.json" > "$OUT/sandbox-diag.pretty.json" || true

echo "$OUT"
