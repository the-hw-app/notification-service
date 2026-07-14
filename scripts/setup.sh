#!/usr/bin/env bash
#
# Idempotent self-host setup for Notification Service on Cloudflare.
#
#   pnpm install && pnpm run setup
#
# Creates the D1 database and queues if they don't exist, patches the
# database_id into wrangler.jsonc, applies migrations, sets the API_KEY
# secret (saving it to the gitignored .api-key.local), and deploys the Worker.
# On completion it prints the ready-to-paste command to add the MCP server to
# Claude, with the API token filled in. Safe to re-run; every step is a no-op
# when already done. Requires an authenticated wrangler (`npx wrangler login`).
# Tear everything back down with `pnpm run teardown`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
WRANGLER_CONFIG="$API_DIR/wrangler.jsonc"
DB_NAME="notification-service"
QUEUE_NAME="notification-service-sends"
DLQ_NAME="notification-service-sends-dlq"

wrangler() {
  (cd "$API_DIR" && npx wrangler "$@")
}

echo "==> Checking wrangler authentication"
if ! wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare. Run: npx wrangler login" >&2
  exit 1
fi

echo "==> Ensuring D1 database '$DB_NAME' exists"
DB_LIST_JSON="$(wrangler d1 list --json)"
DB_ID="$(node -e "
  const dbs = JSON.parse(process.argv[1]);
  const db = dbs.find((d) => d.name === '$DB_NAME');
  process.stdout.write(db ? (db.uuid ?? db.database_id ?? '') : '');
" "$DB_LIST_JSON")"

if [ -z "$DB_ID" ]; then
  echo "    creating..."
  CREATE_OUT="$(wrangler d1 create "$DB_NAME")"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1)"
  if [ -z "$DB_ID" ]; then
    echo "Could not parse database_id from 'wrangler d1 create' output:" >&2
    printf '%s\n' "$CREATE_OUT" >&2
    exit 1
  fi
fi
echo "    database_id: $DB_ID"

echo "==> Patching database_id into wrangler.jsonc"
node -e "
  const fs = require('fs');
  const path = '$WRANGLER_CONFIG';
  const before = fs.readFileSync(path, 'utf8');
  const after = before.replace(/\"database_id\":\s*\"[^\"]*\"/, '\"database_id\": \"$DB_ID\"');
  if (after !== before) fs.writeFileSync(path, after);
"

echo "==> Ensuring queues exist"
EXISTING_QUEUES="$(wrangler queues list 2>/dev/null || true)"
for q in "$QUEUE_NAME" "$DLQ_NAME"; do
  if printf '%s' "$EXISTING_QUEUES" | grep -q "$q"; then
    echo "    $q already exists"
  else
    echo "    creating $q..."
    wrangler queues create "$q"
  fi
done

echo "==> Applying D1 migrations"
wrangler d1 migrations apply "$DB_NAME" --remote

echo "==> API key"
KEY_FILE="$ROOT/.api-key.local"
API_KEY=""
EXISTING_SECRETS="$(wrangler secret list 2>/dev/null || echo '[]')"
if printf '%s' "$EXISTING_SECRETS" | grep -q '"API_KEY"'; then
  echo "    API_KEY secret already set."
  if [ -f "$KEY_FILE" ]; then
    API_KEY="$(cat "$KEY_FILE")"
    echo "    (value read from .api-key.local for the connect command below)"
  else
    echo "    Cloudflare will not reveal it — the connect command below shows a placeholder."
    echo "    To rotate: 'cd apps/api && npx wrangler secret delete API_KEY' then re-run setup."
  fi
else
  API_KEY="${NOTIFICATION_SERVICE_API_KEY:-$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")}"
  printf '%s' "$API_KEY" | wrangler secret put API_KEY
  # Persist to a gitignored file so re-runs — and the connect command below —
  # can reference the key. Cloudflare never reveals a secret once set.
  printf '%s' "$API_KEY" >"$KEY_FILE"
  echo "    Generated a new API key and saved it to .api-key.local (gitignored)."
fi

echo "==> Deploying"
DEPLOY_LOG="$(mktemp)"
wrangler deploy 2>&1 | tee "$DEPLOY_LOG"
WORKER_URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
rm -f "$DEPLOY_LOG"
[ -z "$WORKER_URL" ] && WORKER_URL="https://<your-worker>.workers.dev"
MCP_URL="$WORKER_URL/mcp"

echo ""
echo "=================================================================="
echo " Notification Service is deployed."
echo "=================================================================="
echo ""
echo "   Worker:  $WORKER_URL"
echo "   Health:  curl $WORKER_URL/health"
echo "   MCP:     $MCP_URL"
echo ""
echo "-- Add the MCP server to Claude Code -----------------------------"
echo ""
if [ -n "$API_KEY" ]; then
  echo "   claude mcp add --transport http notification-service \\"
  echo "     $MCP_URL \\"
  echo "     --header \"Authorization: Bearer $API_KEY\""
  echo ""
  echo "   Stdio-only MCP clients can use the mcp-remote proxy instead:"
  echo ""
  echo "   npx mcp-remote $MCP_URL --header \"Authorization: Bearer $API_KEY\""
else
  echo "   claude mcp add --transport http notification-service \\"
  echo "     $MCP_URL \\"
  echo "     --header \"Authorization: Bearer <YOUR_API_KEY>\""
  echo ""
  echo "   (Replace <YOUR_API_KEY> with the key you saved when you first set up.)"
fi
echo ""
echo "   Remove all of this later with:  pnpm run teardown"
echo ""
