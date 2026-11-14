#!/usr/bin/env bash
# Rehearse the MySQL -> Postgres data move end to end with throwaway Docker
# databases (Phase 0.4.4). Needs Docker. Never touches the real databases.
#
#   ./scripts/rehearse-data-move.sh                 # fake data (fixture.sql)
#   ./scripts/rehearse-data-move.sh path/to/dump.sql   # a real mysqldump
#   KEEP=1 ./scripts/rehearse-data-move.sh          # leave containers running
#   PG_PORT=5452 MYSQL_PORT=3417 ./scripts/rehearse-data-move.sh   # other ports
#
# Steps, in go-live order: start MySQL 8 + Postgres 16 -> load the dump ->
# dry run -> real move -> clean-up SQL (fixture: the planted duplicates) ->
# npm run migrate (MUST apply every file; any failure stops the rehearsal) ->
# migrate again (MUST be a no-op) -> checks: every migration recorded, the
# 020 settings row, Admission_counter and its defaults, the named constraints
# of 029-035, every pupil's fees_owing equal to the source -> devSync over
# the migrated database (tables already there) -> a second move is refused.
# Any failed step or check exits non-zero with "REHEARSAL FAILED".
#
# With the fixture the move itself reports: counts match, 4 passwords hashed,
# 1 Term.active default, 2 orphans (Student.class_id, Fee.student_id of a
# deleted pupil), duplicates blocking uniq_marks and uniq_attendance (removed
# by the clean-up step), and the next new pupil id is 51 (above pupil 50).
#
# Uses its own containers (pp-rehearsal-*) and ports (3407 / 5442 by default);
# it refuses to run against the shared live-copy container or port 5443.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP="${1:-scripts/data-move-rehearsal/fixture.sql}"
MYSQL_PORT="${MYSQL_PORT:-3407}"; PG_PORT="${PG_PORT:-5442}"
MY="${MY:-pp-rehearsal-mysql}"; PG="${PG:-pp-rehearsal-pg}"
if [ "$PG_PORT" = "5443" ] || [ "$PG" = "pp-live-copy-pg" ] || [ "$MY" = "pp-live-copy-pg" ]; then
  echo "Refusing: port 5443 / pp-live-copy-pg is the shared live copy." >&2; exit 1
fi
fail() { echo; echo "✗ REHEARSAL FAILED: $*" >&2; exit 1; }
psql_q() { docker exec "$PG" psql -U pp -d perfectpeace -v ON_ERROR_STOP=1 -tAc "$1"; }
NODE="npx -y node@20"   # jsonwebtoken/bcrypt need Node 20 (prod runs node:20)

cleanup() { [ "${KEEP:-}" = "1" ] || docker rm -f "$MY" "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$MY" "$PG" >/dev/null 2>&1 || true
docker run -d --name "$MY" -e MYSQL_ROOT_PASSWORD=rootpw -p $MYSQL_PORT:3306 mysql:8.0 >/dev/null
docker run -d --name "$PG" -e POSTGRES_USER=pp -e POSTGRES_PASSWORD=pppw -e POSTGRES_DB=perfectpeace -p $PG_PORT:5432 postgres:16 >/dev/null

echo "→ waiting for MySQL …"
until docker exec "$MY" mysql -uroot -prootpw -e "SELECT 1" >/dev/null 2>&1; do sleep 2; done
until docker exec "$PG" pg_isready -U pp >/dev/null 2>&1; do sleep 1; done

echo "→ loading $DUMP"
if grep -qi "CREATE DATABASE" "$DUMP"; then
  docker exec -i "$MY" mysql -uroot -prootpw < "$DUMP" 2>&1 | grep -v Warning || true
else
  docker exec "$MY" mysql -uroot -prootpw -e "CREATE DATABASE IF NOT EXISTS dbo" 2>/dev/null
  docker exec -i "$MY" mysql -uroot -prootpw dbo < "$DUMP" 2>&1 | grep -v Warning || true
fi

export DB_HOST=localhost DB_PORT=$PG_PORT DB_NAME=perfectpeace DB_USERNAME=pp DB_PASSWORD=pppw
export JWT_KEY=rehearsal SOURCE_MYSQL_URL="mysql://root:rootpw@127.0.0.1:$MYSQL_PORT/dbo"

echo; echo "=== 1. dry run ==="
$NODE node_modules/.bin/babel-node src/scripts/moveFromMysql.js --dry-run
echo; echo "=== 2. move ==="
$NODE node_modules/.bin/babel-node src/scripts/moveFromMysql.js
MIGRATE="$NODE node_modules/.bin/babel-node src/scripts/migrate.js"
IS_FIXTURE=0; [ "$DUMP" = "scripts/data-move-rehearsal/fixture.sql" ] && IS_FIXTURE=1

echo; echo "=== 3. clean-up SQL ==="
if [ $IS_FIXTURE = 1 ]; then
  echo "removing the planted duplicates (Student_marks 3, Attendance 3)"
  psql_q 'DELETE FROM dbo."Student_marks" WHERE student_marks_id = 3' >/dev/null
  psql_q 'DELETE FROM dbo."Attendance" WHERE attendance_id = 3' >/dev/null
else
  echo "(none for a real dump: clean up any duplicates the move reported, then re-run migrate)"
fi

echo; echo "=== 4. migrate (every file must apply) ==="
$MIGRATE || fail "npm run migrate failed (see the error above)"

echo; echo "=== 5. migrate again (must be a no-op) ==="
OUT=$($MIGRATE) || fail "second migrate failed"
echo "$OUT"
echo "$OUT" | grep -q "No pending migrations." || fail "second migrate was not a no-op"

echo; echo "=== 6. checks ==="
FILES=$(ls db/migrations | grep -E '^[0-9]{3}_.*\.sql$' | sort)
APPLIED=$(psql_q 'SELECT name FROM dbo."_migrations" ORDER BY name')
[ "$FILES" = "$APPLIED" ] || fail "applied migrations differ from db/migrations:
$(diff <(echo "$FILES") <(echo "$APPLIED"))"
echo "✓ all $(echo "$APPLIED" | wc -l | tr -d ' ') migration files applied: $(echo "$APPLIED" | sed 's/_.*//' | tr '\n' ' ')"

[ "$(psql_q "SELECT admission_format FROM dbo.\"School_settings\" WHERE school_settings_id = 1")" = "PPS/{YYYY}/{0000}" ] \
  || fail "the 020 School_settings seed row is missing"
echo "✓ School_settings row 1 seeded (034)"
[ "$(psql_q "SELECT to_regclass('dbo.\"Admission_counter\"') IS NOT NULL")" = "t" ] || fail "Admission_counter is missing"
echo "✓ Admission_counter exists"

# Defaults a table made by the model's sync would not have.
for col in School_settings.updated_at Document.created_at Admission_counter.updated_at Admission_counter.last_value Grading_scale.is_default; do
  t=${col%.*}; c=${col#*.}
  d=$(psql_q "SELECT column_default FROM information_schema.columns WHERE table_schema='dbo' AND table_name='$t' AND column_name='$c'")
  [ -n "$d" ] || fail "no database default on $t.$c"
done
echo "✓ database defaults present (updated_at / created_at / last_value / is_default)"
# The service's insert, and an insert that leaves the defaults to the database.
psql_q "BEGIN; INSERT INTO dbo.\"Admission_counter\" (scope) VALUES ('rehearsal'); ROLLBACK;" >/dev/null \
  || fail "Admission_counter insert relying on defaults failed"

EXPECTED_CONSTRAINTS="academic_year_status_chk academic_year_dates_chk Term_academic_year_id_fkey
Student_fees_period_term_id_fkey Student_term_bill_term_id_fkey student_term_bill_kind_chk
discount_type_kind_chk discount_type_value_chk student_discount_source_chk Student_discount_discount_type_id_fkey
Student_discount_from_term_id_fkey Student_discount_to_term_id_fkey
ck_grade_band_range Grade_band_grading_scale_id_fkey Grading_scale_section_grading_scale_id_fkey
document_owner_type_chk document_size_bytes_chk Document_storage_key_key
school_settings_one_row_chk school_settings_primary_color_chk school_settings_accent_color_chk
admission_counter_last_value_chk"
EXPECTED_INDEXES="academic_year_name_uq academic_year_one_current_uq student_term_bill_uq discount_type_name_uq
ux_grading_scale_name ux_grading_scale_one_default idx_grade_band_scale idx_document_owner uniq_student_admission_no"
missing=""
for c in $EXPECTED_CONSTRAINTS; do
  [ "$(psql_q "SELECT COUNT(*) FROM pg_constraint WHERE conname = '$c'")" = "1" ] || missing="$missing $c"
done
for i in $EXPECTED_INDEXES; do
  [ "$(psql_q "SELECT to_regclass('dbo.$i') IS NOT NULL")" = "t" ] || missing="$missing $i"
done
[ -z "$missing" ] || fail "missing constraints/indexes:$missing"
echo "✓ $(echo $EXPECTED_CONSTRAINTS | wc -w | tr -d ' ') named constraints and $(echo $EXPECTED_INDEXES | wc -w | tr -d ' ') named indexes (029-035) exist"
[ "$(psql_q "SELECT COUNT(*) FROM dbo.\"Grade_band\"")" = "15" ] || fail "018 grade band seed incomplete"
echo "✓ 018 grading scales seeded (15 bands)"

# Every pupil's fees_owing after move + migrate equals the source.
SRC_STUDENT=$(docker exec "$MY" mysql -uroot -prootpw -N dbo -e "SHOW TABLES" 2>/dev/null | grep -ix student | head -1)
SRC=$(docker exec "$MY" mysql -uroot -prootpw -N dbo -e \
  "SELECT student_id, COALESCE(CAST(fees_owing AS DECIMAL(18,2)), 'NULL') FROM \`$SRC_STUDENT\` ORDER BY student_id" 2>/dev/null | tr '\t' '|')
DST=$(psql_q 'SELECT student_id, COALESCE(fees_owing::numeric(18,2)::text, $$NULL$$) FROM dbo."Student" ORDER BY student_id')
[ -n "$SRC" ] || fail "could not read the source pupils"
[ "$SRC" = "$DST" ] || fail "fees_owing changed:
$(diff <(echo "$SRC") <(echo "$DST"))"
echo "✓ fees_owing unchanged for all $(echo "$SRC" | wc -l | tr -d ' ') pupil(s)"

if [ $IS_FIXTURE = 1 ]; then
  echo; echo "=== 7. next new pupil id (must be above the deleted pupil 50) ==="
  NEXT=$(psql_q "SELECT nextval(pg_get_serial_sequence('dbo.\"Student\"', 'student_id'))")
  echo "$NEXT"; [ "$NEXT" -gt 50 ] || fail "Student sequence starts at $NEXT"
fi

echo; echo "=== 8. devSync over the migrated database (tables already exist) ==="
$NODE node_modules/.bin/babel-node src/scripts/devSync.js || fail "devSync failed on a migrated database"
OUT=$($NODE node_modules/.bin/babel-node src/scripts/migrate.js --status) || fail "migrate --status failed"
echo "$OUT" | sed -n '/Pending:/,$p'
echo "$OUT" | sed -n '/Pending:/,$p' | grep -q "(none)" || fail "pending migrations after devSync"

echo; echo "=== 9. a second move into the migrated database must be refused ==="
MOVE_LOG=$(mktemp)
if $NODE node_modules/.bin/babel-node src/scripts/moveFromMysql.js >"$MOVE_LOG" 2>&1; then
  fail "the second move loaded over a non-empty database"
fi
grep -q "Target database is not empty" "$MOVE_LOG" || { cat "$MOVE_LOG"; fail "second move failed for another reason"; }
echo "✓ refused: $(grep -o 'Target database is not empty[^.]*' "$MOVE_LOG" | cut -c1-160)…"
rm -f "$MOVE_LOG"

echo; echo "✓ REHEARSAL PASSED"
echo "Postgres is on localhost:$PG_PORT (db perfectpeace, user pp / pppw)."
[ "${KEEP:-}" = "1" ] && echo "Containers kept. Remove with: docker rm -f $MY $PG"
exit 0
