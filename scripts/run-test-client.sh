#!/usr/bin/env bash
# Spin up the TEST-CLIENT stack: a temporary (ephemeral) Postgres + the backend
# API on port 5040, seeded with EXACTLY ONE user — the admin.
#
# Usage:
#   ./scripts/run-test-client.sh              # build locally + run on :5040
#   ./scripts/run-test-client.sh --pull       # pull the registry image (VPS path)
#   ./scripts/run-test-client.sh --down        # tear the stack down
#   ADMIN_USERNAME=boss ADMIN_PASSWORD='S3cret!' ./scripts/run-test-client.sh
#
# If ADMIN_USERNAME/ADMIN_PASSWORD aren't set and the shell is interactive,
# you'll be prompted for them ("you input only the admin").
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root
COMPOSE_FILE="docker-compose.test-client.yml"
ENV_FILE=".env.test-client"
PORT="5040"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# --down: tear everything down (and wipe the temp db, which is tmpfs anyway).
if [ "${1:-}" = "--down" ]; then
  compose down -v
  echo "✅ test-client stack stopped."
  exit 0
fi

MODE="build"
[ "${1:-}" = "--pull" ] && MODE="pull"

# 1. Ensure an env file exists.
if [ ! -f "$ENV_FILE" ]; then
  echo "→ $ENV_FILE not found; creating it from .env.test-client.example"
  cp .env.test-client.example "$ENV_FILE"
fi

# 2. Collect the single admin's credentials.
set_env() { # key value  — upsert KEY=value into $ENV_FILE
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE"; then
    # portable in-place edit (BSD + GNU sed)
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

if [ -n "${ADMIN_USERNAME:-}" ]; then set_env ADMIN_USERNAME "$ADMIN_USERNAME"; fi
if [ -n "${ADMIN_PASSWORD:-}" ]; then set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"; fi

# Prompt only when interactive and not provided via env.
if [ -z "${ADMIN_USERNAME:-}" ] && [ -t 0 ]; then
  read -r -p "Admin username [admin]: " _u; set_env ADMIN_USERNAME "${_u:-admin}"
fi
if [ -z "${ADMIN_PASSWORD:-}" ] && [ -t 0 ]; then
  read -r -s -p "Admin password: " _p; echo
  [ -n "$_p" ] && set_env ADMIN_PASSWORD "$_p"
fi

# 3. Bring the stack up.
echo "→ starting test-client stack ($MODE) on port ${PORT}…"
if [ "$MODE" = "pull" ]; then
  compose pull
  compose up -d
else
  compose up -d --build
fi

# 4. Wait for the API to answer on 5040.
echo -n "→ waiting for API on :$PORT "
for _ in $(seq 1 40); do
  if curl -fs -m 3 "http://localhost:${PORT}/" >/dev/null 2>&1; then
    echo "— up!"
    ADMIN_U=$(grep '^ADMIN_USERNAME=' "$ENV_FILE" | cut -d= -f2-)
    echo ""
    echo "✅ Test-client API: http://localhost:${PORT}"
    echo "   Admin login -> username: ${ADMIN_U:-admin} | category: Administrator | password: (the one you set)"
    echo "   Logs:  docker logs -f pp-test-backend"
    echo "   Stop:  ./scripts/run-test-client.sh --down"
    exit 0
  fi
  sleep 2; echo -n "."
done

echo ""
echo "❌ API did not come up in time. Recent backend logs:"
compose logs --tail=40 backend || true
exit 1
