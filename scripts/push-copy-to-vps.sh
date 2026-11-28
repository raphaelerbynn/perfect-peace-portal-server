#!/usr/bin/env bash
# Put the LOCAL copy of the live data onto the TEST-CLIENT VPS, replacing the
# test database there. Run it on the developer's Mac, from
# perfect-peace-portal-server.
#
# The data comes from ./scripts/copy-live-to-local.sh (container pp-live-copy-pg):
# live MySQL moved into Postgres, migrated, phone numbers blanked. This script
#   1. checks the local copy: running, migrated, and NO phone numbers left
#   2. dumps it (schema dbo only)
#   3. asks before touching the VPS
#   4. uploads it, stops the API, replaces the database, sets every office,
#      staff and pupil login to VPS_TEST_PASSWORD, deletes the uploaded file
#   5. starts the API again (src/scripts/testClientStart.js applies any
#      migrations the VPS image has that the copy doesn't yet)
# The live MySQL is never contacted, and no live password goes to the VPS.
#
# Usage:
#   VPS_SSH=user@host VPS_TEST_PASSWORD='a long password' ./scripts/push-copy-to-vps.sh
# Optional:
#   VPS_PORT=22                         SSH port
#   VPS_KEY=~/.ssh/contabo_deploy       SSH key file
#   VPS_DIR=/opt/projects/perfect_peace the stack's folder on the VPS
#   YES=1                               don't ask before replacing
# Fresh data first:  YES=1 ./scripts/copy-live-to-local.sh  (then run this)
#
# The test site is reachable from the internet and holds real names, marks and
# balances, so VPS_TEST_PASSWORD must be 12+ characters (admin123 is refused).
# Give it to the school's testers separately; never put it in the manual.
set -euo pipefail
cd "$(dirname "$0")/.."

PG=pp-live-copy-pg
VPS_DIR="${VPS_DIR:-/opt/projects/perfect_peace}"
DB_CT="${DB_CT:-pp-test-db}"
API_CT="${API_CT:-pp-test-backend}"

: "${VPS_SSH:?Set VPS_SSH=user@host (the test-client VPS)}"
PW="${VPS_TEST_PASSWORD:-}"
if [ "${#PW}" -lt 12 ] || [ "$PW" = "admin123" ]; then
  echo "Set VPS_TEST_PASSWORD to 12 or more characters (not admin123): the test site is on the internet."
  exit 1
fi

SSH=(ssh -p "${VPS_PORT:-22}" -o BatchMode=yes)
SCP=(scp -P "${VPS_PORT:-22}" -o BatchMode=yes -q)
if [ -n "${VPS_KEY:-}" ]; then SSH+=(-i "$VPS_KEY"); SCP+=(-i "$VPS_KEY"); fi

echo "=== 0. reach the VPS ==="
if [ "$VPS_SSH" != "local" ]; then
  "${SSH[@]}" -o ConnectTimeout=15 "$VPS_SSH" "test -d '$VPS_DIR'" </dev/null || {
    echo "Can't sign in to $VPS_SSH with ${VPS_KEY:-the default key} (or $VPS_DIR is missing)."
    echo "Check VPS_SSH and VPS_KEY with: ssh -i <key> $VPS_SSH echo ok"; exit 1; }
  echo "  signed in to $VPS_SSH"
fi
echo

psql_local() { docker exec -i "$PG" psql -U pp -d perfectpeace -v ON_ERROR_STOP=1 -qtA "$@"; }

echo "=== 1. check the local copy ($PG) ==="
docker ps --format '{{.Names}}' | grep -qx "$PG" ||
  { echo "The local copy isn't running. Make it with: YES=1 ./scripts/copy-live-to-local.sh"; exit 1; }
[ "$(psql_local -c "SELECT to_regclass('\"dbo\".\"_migrations\"') IS NOT NULL")" = "t" ] ||
  { echo "The local copy has no migration history. Make it again with ./scripts/copy-live-to-local.sh"; exit 1; }
phones="$(psql_local -c "
  SELECT (SELECT count(*) FROM dbo.\"Parent\"
           WHERE coalesce(trim(contact), '') <> '' OR coalesce(trim(contact1), '') <> '')
       + (SELECT count(*) FROM dbo.\"Teacher\" WHERE coalesce(trim(phone), '') <> '')")"
if [ "$phones" != "0" ]; then
  echo "Stop: the local copy still has $phones phone number(s). Run ./scripts/copy-live-to-local.sh --migrate (it blanks them)."
  exit 1
fi
summary="$(psql_local -c "SELECT 'pupils ' || (SELECT count(*) FROM dbo.\"Student\" WHERE is_deleted IS NOT TRUE)
  || ', staff ' || (SELECT count(*) FROM dbo.\"Teacher\" WHERE is_deleted IS NOT TRUE)
  || ', payments ' || (SELECT count(*) FROM dbo.\"Fee\")
  || ', last migration ' || (SELECT max(name) FROM dbo.\"_migrations\")")"
echo "  $summary; phone numbers: none"

echo; echo "=== 2. dump it ==="
DUMP="$(mktemp -t pp-vps-copy).dump"
trap 'rm -f "$DUMP"' EXIT
docker exec "$PG" pg_dump -U pp -d perfectpeace -n dbo -Fc --no-owner --no-privileges -f /tmp/vps-copy.dump
docker cp -q "$PG":/tmp/vps-copy.dump "$DUMP"; chmod 600 "$DUMP"
docker exec "$PG" rm -f /tmp/vps-copy.dump
echo "  $(du -h "$DUMP" | cut -f1) dump"

# bcrypt hash of the test password, made here (bcrypt is in node_modules);
# base64 so it passes the remote shell untouched.
NODE_BIN="$(npx -y node@20 -p process.execPath)"   # bcrypt is built for Node 20
HASH_B64="$(PW="$PW" "$NODE_BIN" -e "require('bcrypt').hash(process.env.PW,10).then(h=>process.stdout.write(Buffer.from(h).toString('base64')))")"

if [ "${YES:-}" != "1" ]; then
  echo; read -r -p "Replace the test database on $VPS_SSH ($VPS_DIR, $DB_CT) with this copy? Type yes: " ans
  [ "$ans" = "yes" ] || { echo "Stopped. Nothing sent."; exit 0; }
fi

# Runs on the VPS (or on this Mac with VPS_SSH=local, to try the script out).
REMOTE='
set -euo pipefail
cd "$1"; DB_CT="$2"; API_CT="$3"; HASH="$(printf %s "$4" | base64 -d)"
val() { grep -E "^$1=" .env.test-client 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^\"(.*)\"$/\\1/"; }
DB_USER="$(val DB_USERNAME)"; DB_USER="${DB_USER:-perfectpeace}"
DB_NAME="$(val DB_NAME)"; DB_NAME="${DB_NAME:-perfectpeace_test}"
q() { docker exec "$DB_CT" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -qtA "$@"; }
echo "  stopping the API ($API_CT)"; docker stop "$API_CT" >/dev/null
docker cp -q live-copy.dump "$DB_CT":/tmp/live-copy.dump
echo "  replacing the database"
q -c "SET client_min_messages = warning; DROP SCHEMA IF EXISTS dbo CASCADE"
if ! docker exec "$DB_CT" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges /tmp/live-copy.dump; then
  echo "  The restore failed; the API is started again on what is there now."
  docker start "$API_CT" >/dev/null; exit 1
fi
docker exec "$DB_CT" rm -f /tmp/live-copy.dump; rm -f live-copy.dump
q -c "UPDATE dbo.\"User_account\" SET password = '"'"'$HASH'"'"'"
q -c "UPDATE dbo.\"Teacher\" SET password = '"'"'$HASH'"'"'"
q -c "UPDATE dbo.\"Student\" SET password = '"'"'$HASH'"'"'"
echo "  every login now uses the test password"
echo "  on the VPS: $(q -c "SELECT count(*) FROM dbo.\"Student\" WHERE is_deleted IS NOT TRUE") pupils"
echo "  starting the API (pending migrations run first)"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker start "$API_CT" >/dev/null
for _ in $(seq 1 60); do
  st="$(docker inspect -f "{{.State.Running}}" "$API_CT")"
  docker logs --since "$since" "$API_CT" 2>&1 | grep -q "server running" && { echo "  API is up"; echo PUSH_COMPLETE; exit 0; }
  [ "$st" = "true" ] || break
  sleep 2
done
echo "  The API did not come up. Last lines of its log:"; docker logs --tail 30 "$API_CT" 2>&1; exit 1
'

# The steps travel as a file and run as a file, never fed to bash on stdin: a
# command that reads stdin (e.g. docker exec -i) would swallow the rest of the
# script and bash would stop silently halfway (it did, after DROP SCHEMA).
STEPS="$(mktemp -t pp-vps-steps)"
trap 'rm -f "$DUMP" "$STEPS"' EXIT
printf '%s\n' "$REMOTE" > "$STEPS"

echo; echo "=== 3. upload and replace on $VPS_SSH ==="
if [ "$VPS_SSH" = "local" ]; then
  cp "$DUMP" "$VPS_DIR/live-copy.dump"
  out="$(bash "$STEPS" "$VPS_DIR" "$DB_CT" "$API_CT" "$HASH_B64" </dev/null 2>&1 | tee /dev/stderr)" || true
else
  "${SCP[@]}" "$DUMP" "$VPS_SSH:$VPS_DIR/live-copy.dump"
  "${SCP[@]}" "$STEPS" "$VPS_SSH:$VPS_DIR/push-copy-steps.sh"
  out="$("${SSH[@]}" "$VPS_SSH" "bash '$VPS_DIR/push-copy-steps.sh' '$VPS_DIR' '$DB_CT' '$API_CT' '$HASH_B64'; rc=\$?; rm -f '$VPS_DIR/push-copy-steps.sh'; exit \$rc" </dev/null 2>&1 | tee /dev/stderr)" || true
fi
# Done only when the VPS says so: a run cut short must never look finished.
grep -q '^PUSH_COMPLETE$' <<<"$out" || {
  echo; echo "NOT finished: the VPS did not confirm the API is up with the copy. Read the lines above."; exit 1; }

echo; echo "Done. The test site now has: $summary."
echo "Sign in with any live login (e.g. an Administrator) and the test password."
