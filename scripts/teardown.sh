#!/usr/bin/env bash
#
# Tear down ALL Notification Service Cloudflare infrastructure.
#
#   pnpm run teardown              # asks for confirmation first
#   pnpm run teardown -- --yes     # non-interactive (also: NOTIFICATION_SERVICE_DESTROY_YES=1)
#
# Deletes the Worker (and its secrets), both queues, and the D1 database — in
# that order (the Worker is the queue's consumer, so it must go first). This
# PERMANENTLY DESTROYS all data: users, devices, notifications, and send
# history. There is no undo. Requires an authenticated wrangler.
#
# Every step tolerates an already-missing resource, so a half-torn-down
# instance can be finished by re-running. Note: NOT `set -e` — one missing
# resource must not abort the rest.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
WORKER_NAME="notification-service"
DB_NAME="notification-service"
QUEUE_NAME="notification-service-sends"
DLQ_NAME="notification-service-sends-dlq"
KEY_FILE="$ROOT/.api-key.local"

wrangler() {
  (cd "$API_DIR" && npx wrangler "$@")
}

# --- parse flags -------------------------------------------------------------
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y | --yes) ASSUME_YES=1 ;;
  esac
done
[ "${NOTIFICATION_SERVICE_DESTROY_YES:-}" = "1" ] && ASSUME_YES=1

echo "==> Checking wrangler authentication"
if ! wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare. Run: npx wrangler login" >&2
  exit 1
fi

# --- confirmation gate -------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  echo "  This will PERMANENTLY DELETE the following on Cloudflare:"
  echo "    - Worker:        $WORKER_NAME  (and its API_KEY secret)"
  echo "    - Queues:        $QUEUE_NAME, $DLQ_NAME"
  echo "    - D1 database:   $DB_NAME  (ALL users, devices, notifications, sends)"
  echo ""
  echo "  There is no undo."
  echo ""
  printf "  Type the worker name '%s' to confirm: " "$WORKER_NAME"
  read -r REPLY
  if [ "$REPLY" != "$WORKER_NAME" ]; then
    echo "Aborted — nothing was deleted."
    exit 1
  fi
fi

# --- 1. Worker (removes the queue consumer/producer + the API_KEY secret) -----
echo "==> Deleting Worker '$WORKER_NAME'"
if yes | wrangler delete "$WORKER_NAME" --force; then
  echo "    deleted."
else
  echo "    (not found or already deleted — continuing)"
fi

# --- 2. Queues (main first so the DLQ has no referrer) -----------------------
for q in "$QUEUE_NAME" "$DLQ_NAME"; do
  echo "==> Deleting queue '$q'"
  if wrangler queues delete "$q"; then
    echo "    deleted."
  else
    echo "    (not found or already deleted — continuing)"
  fi
done

# --- 3. D1 database ----------------------------------------------------------
echo "==> Deleting D1 database '$DB_NAME'"
if wrangler d1 delete "$DB_NAME" -y; then
  echo "    deleted."
else
  echo "    (not found or already deleted — continuing)"
fi

# --- 4. Local key file -------------------------------------------------------
if [ -f "$KEY_FILE" ]; then
  rm -f "$KEY_FILE"
  echo "==> Removed local .api-key.local"
fi

echo ""
echo "Done. All Notification Service infrastructure has been removed."
echo "(The 'database_id' left in apps/api/wrangler.jsonc is harmless; 'pnpm run setup' repopulates it.)"
