#!/usr/bin/env bash
# Reset and re-ensure the production sandbox at vercel-openclaw-7.
#
# Loads ADMIN_SECRET + VERCEL_AUTOMATION_BYPASS_SECRET from
# .env.agent (preferred at repo root, falls back to .claude/.env.agent).
#
# Usage:
#   scripts/reset.sh                    # reset + ensure (default)
#   scripts/reset.sh --reset-only       # just reset, skip ensure
#   scripts/reset.sh --base-url <url>   # override the deployment URL

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=""
for candidate in "$REPO_ROOT/.env.agent" "$REPO_ROOT/.claude/.env.agent"; do
  if [[ -f "$candidate" ]]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [[ -z "$ENV_FILE" ]]; then
  echo "error: no .env.agent found at .env.agent or .claude/.env.agent" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${ADMIN_SECRET:?missing ADMIN_SECRET in $ENV_FILE}"
: "${VERCEL_AUTOMATION_BYPASS_SECRET:?missing VERCEL_AUTOMATION_BYPASS_SECRET in $ENV_FILE}"

BASE_URL="${OPENCLAW_BASE_URL:-https://vercel-openclaw-7.playground-vercel.tools}"
RESET_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset-only) RESET_ONLY=1; shift ;;
    --base-url)   BASE_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | head -n 14
      exit 0
      ;;
    *) echo "error: unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "→ env file: ${ENV_FILE/#$HOME/~}"
echo "→ target:   $BASE_URL"
echo

echo "=== POST /api/admin/reset ==="
curl -fsS "$BASE_URL/api/admin/reset" \
  -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "content-type: application/json" \
  -d '{}' \
  -w "\nstatus=%{http_code}\n"

if [[ "$RESET_ONLY" == "1" ]]; then
  echo
  echo "→ --reset-only set; skipping ensure."
  exit 0
fi

echo
echo "=== POST /api/admin/ensure?wait=1 (timeout 180s) ==="
curl -fsS "$BASE_URL/api/admin/ensure?wait=1&timeoutMs=180000" \
  -X POST \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "content-type: application/json" \
  -d '{}' \
  --max-time 200 \
  -w "\nstatus=%{http_code}\n"

echo
echo "→ done. chat: $BASE_URL/gateway/chat?session=main"
