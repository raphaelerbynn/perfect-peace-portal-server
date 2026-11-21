#!/usr/bin/env bash
# Copy the LIVE MySQL data into a LOCAL Postgres for testing.
#
# The live database is only READ (SHOW TABLES / SHOW COLUMNS / SELECT, via
# src/scripts/moveFromMysql.js). Nothing is written to it.
#
# Everything is written to a separate local Docker Postgres:
#   container pp-live-copy-pg, port 5443, db perfectpeace, user pp / pppw,
#   data kept in the Docker volume pp-live-copy-data.
# It is separate from the rehearsal database (pp-rehearsal-pg, 5442), so
# re-running rehearse-data-move.sh never wipes this copy.
#
# The live login is read from .env (never printed):
#   LIVE_DB_HOST=...   (default)
#   LIVE_DB_PORT=3306                      (default)
#   LIVE_DB_USER=...
#   LIVE_DB_PASSWORD=...
#   LIVE_DB_NAME=...
#
# Usage (from perfect-peace-portal-server):
#   ./scripts/copy-live-to-local.sh              # full copy (asks to confirm)
#   YES=1 ./scripts/copy-live-to-local.sh        # full copy, no question
#   ./scripts/copy-live-to-local.sh --dry-run    # only the report, nothing written anywhere
#   ./scripts/copy-live-to-local.sh --migrate    # re-run migrations on the local copy
#   ./scripts/copy-live-to-local.sh --api        # (re)start the API on the local copy
#   ./scripts/copy-live-to-local.sh --test-passwords  # every login in the COPY gets
#                                                # LOCAL_TEST_PASSWORD (default admin123)
#   ./scripts/copy-live-to-local.sh --snapshot   # save the copy as it is now
#   ./scripts/copy-live-to-local.sh --restore    # put the copy back to the snapshot
#                                                # (taken automatically after a copy)
#
# After the copy, the LOCAL copy only:
#   - every parent and staff phone number is blanked (no SMS to real people)
#   - every Administrator office login gets the password LOCAL_ADMIN_PASSWORD
#     (default admin123)
#   - the API is (re)started on port 5050 with SMS off and no outside calls.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-copy}"
PG=pp-live-copy-pg; PG_VOL=pp-live-copy-data; PG_PORT=5443
LOG_DIR="$HOME/pp-live-dump"; mkdir -p "$LOG_DIR"; chmod 700 "$LOG_DIR"

# --- read one KEY from .env without sourcing it (values may have spaces/quotes)
envval() {
  [ -f .env ] || return 0
  grep -E "^[[:space:]]*$1[[:space:]]*=" .env | tail -1 |
    sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'
}

# --- Node 20 (jsonwebtoken/bcrypt need it). Resolved WITHOUT the proxy below.
NODE_BIN="$(npx -y node@20 -p process.execPath)"
BABEL="$NODE_BIN node_modules/@babel/node/bin/babel-node.js"

# --- the local target: always this local container, never .env's DB_*
export DB_HOST=localhost DB_PORT=$PG_PORT DB_NAME=perfectpeace DB_USERNAME=pp DB_PASSWORD=pppw
export JWT_KEY="${JWT_KEY:-$(envval JWT_KEY)}"; JWT_KEY="${JWT_KEY:-local-copy}"
psql_local() { docker exec -i "$PG" psql -U pp -d perfectpeace -v ON_ERROR_STOP=1 -qtA "$@"; }

start_local_pg() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG"; then
    if docker ps -a --format '{{.Names}}' | grep -qx "$PG"; then
      docker start "$PG" >/dev/null
    else
      docker run -d --name "$PG" -v "$PG_VOL":/var/lib/postgresql/data \
        -e POSTGRES_USER=pp -e POSTGRES_PASSWORD=pppw -e POSTGRES_DB=perfectpeace \
        -p $PG_PORT:5432 postgres:16 >/dev/null
    fi
  fi
  until docker exec "$PG" pg_isready -U pp -d perfectpeace >/dev/null 2>&1; do sleep 1; done
  # pg_isready can pass during the image's first-boot restart; wait for a real query
  until psql_local -c "SELECT 1" >/dev/null 2>&1; do sleep 1; done
}

stop_api() {
  for pid in $(pgrep -f "babel-node(\.js)? src/index\.js" || true); do kill "$pid" 2>/dev/null || true; done
  sleep 2
}

start_api() {
  stop_api
  ( ARKESEL_KEY= HTTPS_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
    SERVER_PORT=5050 CORS_ORIGINS=http://localhost:3000,http://localhost:5173 \
    nohup $BABEL src/index.js > "$LOG_DIR/api.log" 2>&1 < /dev/null & )
  local c=000
  for _ in $(seq 1 45); do
    c=$(curl -s -o /dev/null -w '%{http_code}' localhost:5050/teacher/my-classes || true)
    [ "$c" = 401 ] && break; sleep 2
  done
  if [ "$c" = 401 ]; then
    echo "API running on http://localhost:5050 (local copy on port $PG_PORT). Log: $LOG_DIR/api.log"
  else
    echo "API did not start; see $LOG_DIR/api.log"; exit 1
  fi
}

run_migrations() {
  if ! $BABEL src/scripts/migrate.js; then
    cat <<EOF

Migrations stopped (usually duplicate rows that a unique index refuses; the
dry-run report lists them under "duplicates"). Clean them in the LOCAL copy:
  docker exec -it $PG psql -U pp -d perfectpeace
then run: ./scripts/copy-live-to-local.sh --migrate
EOF
    exit 1
  fi
}

finish() {
  echo; echo "=== 4. remove duplicate registers / attendance totals (kept in dbo._removed_duplicates) ==="
  psql_local < db/cleanup/before-001-remove-duplicates.sql
  psql_local -c "SELECT '  ' || table_name || ': ' || count(*) || ' row(s) removed' FROM dbo._removed_duplicates GROUP BY table_name ORDER BY 1"

  echo; echo "=== 5. migrations 001… ==="
  run_migrations

  echo; echo "=== 6. make the local copy safe to test with ==="
  psql_local -c "UPDATE dbo.\"Parent\" SET contact = '', contact1 = NULL"
  psql_local -c "UPDATE dbo.\"Teacher\" SET phone = NULL"
  echo "Phone numbers blanked: parents $(psql_local -c "SELECT count(*) FROM dbo.\"Parent\""), staff $(psql_local -c "SELECT count(*) FROM dbo.\"Teacher\"")"
  ADMIN_PW="${LOCAL_ADMIN_PASSWORD:-admin123}"
  HASH="$(PW="$ADMIN_PW" "$NODE_BIN" -e "require('bcrypt').hash(process.env.PW,10).then(h=>process.stdout.write(h))")"
  psql_local -c "UPDATE dbo.\"User_account\" SET password = '$HASH' WHERE category = 'Administrator'"
  echo "Administrator logins (local password = LOCAL_ADMIN_PASSWORD, default admin123):"
  psql_local -c "SELECT '  ' || username FROM dbo.\"User_account\" WHERE category = 'Administrator' AND is_deleted IS NOT TRUE"

  echo; echo "=== 7. what was copied ==="
  psql_local -c "SELECT '  pupils ' || (SELECT count(*) FROM dbo.\"Student\" WHERE is_deleted IS NOT TRUE) || ', staff ' || (SELECT count(*) FROM dbo.\"Teacher\" WHERE is_deleted IS NOT TRUE) || ', classes ' || (SELECT count(*) FROM dbo.\"Class\") || ', payments ' || (SELECT count(*) FROM dbo.\"Fee\") || ', terms ' || (SELECT count(*) FROM dbo.\"Term\")"

  echo; echo "=== 8. snapshot (so tests can be undone with --restore) ==="
  take_snapshot

  echo; echo "=== 9. API ==="
  start_api
  echo; echo "Done. Logs and reports: $LOG_DIR"
}

SNAPSHOT="$LOG_DIR/copy-baseline.dump"
take_snapshot() {
  docker exec "$PG" pg_dump -U pp -d perfectpeace -Fc -f /tmp/baseline.dump
  docker cp -q "$PG":/tmp/baseline.dump "$SNAPSHOT"; chmod 600 "$SNAPSHOT"
  echo "Snapshot saved: $SNAPSHOT"
}
restore_snapshot() {
  [ -f "$SNAPSHOT" ] || { echo "No snapshot at $SNAPSHOT"; exit 1; }
  stop_api
  docker cp -q "$SNAPSHOT" "$PG":/tmp/baseline.dump
  psql_local -c 'DROP SCHEMA IF EXISTS dbo CASCADE' 2>/dev/null
  docker exec "$PG" pg_restore -U pp -d perfectpeace /tmp/baseline.dump
  echo "Copy restored from $SNAPSHOT"
}
test_passwords() {
  local pw="${LOCAL_TEST_PASSWORD:-admin123}" hash
  hash="$(PW="$pw" "$NODE_BIN" -e "require('bcrypt').hash(process.env.PW,10).then(h=>process.stdout.write(h))")"
  psql_local -c "UPDATE dbo.\"User_account\" SET password = '$hash'"
  psql_local -c "UPDATE dbo.\"Teacher\" SET password = '$hash'"
  psql_local -c "UPDATE dbo.\"Student\" SET password = '$hash'"
  echo "Every office, staff and pupil login in the LOCAL copy now uses the password: $pw"
}

case "$MODE" in
  --api) start_local_pg; start_api; exit 0 ;;
  --snapshot) start_local_pg; take_snapshot; exit 0 ;;
  --restore) start_local_pg; restore_snapshot; start_api; exit 0 ;;
  --test-passwords) start_local_pg; test_passwords; exit 0 ;;
  --migrate) start_local_pg; finish; exit 0 ;;
  copy|--dry-run) ;;
  *) echo "Unknown option $MODE"; exit 2 ;;
esac

# --- the live login (read-only use)
L_HOST="${LIVE_DB_HOST:-$(envval LIVE_DB_HOST)}"; L_HOST="${L_HOST:-server8.stormerhost.com}"
L_PORT="${LIVE_DB_PORT:-$(envval LIVE_DB_PORT)}"; L_PORT="${L_PORT:-3306}"
L_USER="${LIVE_DB_USER:-$(envval LIVE_DB_USER)}"; L_PASS="${LIVE_DB_PASSWORD:-$(envval LIVE_DB_PASSWORD)}"; L_NAME="${LIVE_DB_NAME:-$(envval LIVE_DB_NAME)}"
missing=""
[ -n "$L_USER" ] || missing="$missing LIVE_DB_USER"
[ -n "$L_PASS" ] || missing="$missing LIVE_DB_PASSWORD"
[ -n "$L_NAME" ] || missing="$missing LIVE_DB_NAME"
if [ -n "$missing" ]; then
  echo "Fill these in perfect-peace-portal-server/.env first:$missing"; exit 1
fi
SOURCE_MYSQL_URL="$(U="$L_USER" P="$L_PASS" H="$L_HOST" O="$L_PORT" D="$L_NAME" "$NODE_BIN" -e '
  const e = encodeURIComponent, v = process.env;
  process.stdout.write(`mysql://${e(v.U)}:${e(v.P)}@${v.H}:${v.O}/${e(v.D)}`);')"
export SOURCE_MYSQL_URL

echo "Live (read only): $L_USER@$L_HOST:$L_PORT/$L_NAME"
echo "Local target:     Docker $PG, localhost:$PG_PORT/perfectpeace"

start_local_pg

echo; echo "=== 1. dry run (reads live, writes nothing) ==="
$BABEL src/scripts/moveFromMysql.js --dry-run 2>&1 | tee "$LOG_DIR/dry-run.log"
[ "$MODE" = "--dry-run" ] && { echo; echo "Dry run only. Log: $LOG_DIR/dry-run.log"; exit 0; }

if [ "${YES:-}" != "1" ]; then
  echo; read -r -p "Replace the LOCAL copy ($PG) with the live data now? Type yes: " ans
  [ "$ans" = "yes" ] || { echo "Stopped. Nothing written."; exit 0; }
fi

echo; echo "=== 2. empty the local copy ==="
stop_api
psql_local -c 'DROP SCHEMA IF EXISTS dbo CASCADE'

echo; echo "=== 3. move live -> local Postgres ==="
$BABEL src/scripts/moveFromMysql.js 2>&1 | tee "$LOG_DIR/move.log"

finish
