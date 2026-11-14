#!/usr/bin/env bash
# Rehearse the top-up sync (npm run sync-data) on the fake data, in throwaway
# containers. Never touches live or the shared live copy.
#
#   ./scripts/rehearse-sync.sh            # KEEP=1 leaves the containers running
#
# 1. fixture -> MySQL; move -> clean-up (keep the latest save) -> migrate
# 2. sync straight after: must change NOTHING (proves the sync agrees with
#    the move + migrations)
# 3. change "live": a payment (and the old app's balance update), a phone, a
#    password, a new pupil, a register saved twice, a JHS mark, a new term, a
#    deleted event
# 4. dry run: reports the changes, saves nothing (row counts, receipt numbers)
# 5. sync: every change arrives, duplicates resolved, derived columns right,
#    balances equal live by the app's own calculation
# 6. sync again: no change
# 7. --mirror-deletes removes the deleted event
# 8. a payment recorded in the new system: the sync refuses
set -euo pipefail
cd "$(dirname "$0")/.."

MYSQL_PORT="${MYSQL_PORT:-3409}"; PG_PORT="${PG_PORT:-5447}"
MY=pp-sync-reh-mysql; PG=pp-sync-reh-pg
NODE="npx -y node@20"
BN="$NODE node_modules/@babel/node/lib/_babel-node"
WORK=$(mktemp -d)

fail() { echo; echo "✗ SYNC REHEARSAL FAILED: $*" >&2; exit 1; }
pg() { docker exec "$PG" psql -U pp -d perfectpeace -v ON_ERROR_STOP=1 -tAc "$1"; }
my() { docker exec "$MY" mysql -uroot -prootpw dbo -N -e "$1" 2>/dev/null; }
expect() { [ "$2" = "$3" ] || fail "$1: expected [$3], got [$2]"; echo "✓ $1"; }
cleanup() { rm -rf "$WORK"; [ "${KEEP:-}" = "1" ] || docker rm -f "$MY" "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$MY" "$PG" >/dev/null 2>&1 || true
docker run -d --name "$MY" -e MYSQL_ROOT_PASSWORD=rootpw -p 127.0.0.1:$MYSQL_PORT:3306 mysql:8.0 >/dev/null
docker run -d --name "$PG" -e POSTGRES_USER=pp -e POSTGRES_PASSWORD=pppw -e POSTGRES_DB=perfectpeace -p 127.0.0.1:$PG_PORT:5432 postgres:16 >/dev/null
until docker exec "$MY" mysql -uroot -prootpw -e "SELECT 1" >/dev/null 2>&1; do sleep 2; done
sleep 5; until docker exec "$MY" mysql -uroot -prootpw -e "SELECT 1" >/dev/null 2>&1; do sleep 2; done
until docker exec "$PG" pg_isready -U pp >/dev/null 2>&1; do sleep 1; done
docker exec "$MY" mysql -uroot -prootpw -e "CREATE DATABASE dbo" 2>/dev/null
docker exec -i "$MY" mysql -uroot -prootpw dbo < scripts/data-move-rehearsal/fixture.sql 2>&1 | grep -v Warning || true

export DB_HOST=localhost DB_PORT=$PG_PORT DB_NAME=perfectpeace DB_USERNAME=pp DB_PASSWORD=pppw
export JWT_KEY=rehearsal ARKESEL_KEY= SOURCE_MYSQL_URL="mysql://root:rootpw@127.0.0.1:$MYSQL_PORT/dbo"
SYNC="$BN src/scripts/syncFromMysql.js"

echo "=== 1. move -> clean-up -> migrate ==="
$BN src/scripts/moveFromMysql.js > "$WORK/move.log" || { cat "$WORK/move.log"; fail "move"; }
docker exec -i "$PG" psql -U pp -d perfectpeace -q -v ON_ERROR_STOP=1 < db/cleanup/before-001-remove-duplicates.sql
# The planted duplicate mark (2 and 3: same pupil, subject, class, term): keep the latest, logged like the clean-up.
pg "WITH gone AS (DELETE FROM dbo.\"Student_marks\" WHERE student_marks_id = 2 RETURNING *)
    INSERT INTO dbo._removed_duplicates (table_name, row_data) SELECT 'Student_marks', to_jsonb(gone) FROM gone" >/dev/null
$BN src/scripts/migrate.js > "$WORK/migrate.log" || { cat "$WORK/migrate.log"; fail "migrate"; }
echo "✓ moved and migrated"

echo; echo "=== 2. sync straight after the move: must change nothing ==="
$SYNC > "$WORK/s0.log" 2>&1 || { cat "$WORK/s0.log"; fail "first sync"; }
grep -q "^+0 added, ~0 updated, 0 duplicate(s) removed" "$WORK/s0.log" || { cat "$WORK/s0.log"; fail "a sync right after the move changed rows"; }
grep -q '"pupilsRebased":0' "$WORK/s0.log" || { cat "$WORK/s0.log"; fail "a sync right after the move re-based balances"; }
echo "✓ nothing changed"

echo; echo "=== 3. changes in live ==="
TODAY=$(date +%F)
my "INSERT INTO Fee VALUES (3,1,1,900,100,300,'Cash','One hundred','2','2026-02-15');
    UPDATE Student SET fees_owing = 300, fees_paid = 600 WHERE student_id = 1;
    UPDATE Parent SET contact = '0209998888' WHERE parent_id = 1;
    UPDATE Student SET password = 'newpass9' WHERE student_id = 1;
    INSERT INTO Student (student_id,password,f_name,l_name,gender,class,parent_id,class_id,fees_paid,fees_owing)
      VALUES (60,'kid60','Esi','Asante','F','JHS 1',2,1,0,900);
    INSERT INTO Attendance VALUES (7,'JHS 1',1,2,'Present','2026-01-08',NULL);
    INSERT INTO Student_marks VALUES (8,1,60,70,49,80,24,73,'JHS 1','Very Good','2',2,'2026-02-03');
    INSERT INTO Term VALUES (4,'1','2026-09-07','2026-12-11',NULL,b'0');
    DELETE FROM Event WHERE event_id = 1;"
echo "✓ live changed"

echo; echo "=== 3b. a live value the new database can't take: refused, with the row named ==="
if $SYNC > "$WORK/bad.log" 2>&1; then cat "$WORK/bad.log"; fail "sync accepted a pupil with no date of birth"; fi
grep -q "Student.dob: 1 row(s) empty but required (student_id 60)" "$WORK/bad.log" || { cat "$WORK/bad.log"; fail "refusal does not name pupil 60"; }
echo "✓ refused, names pupil 60"
my "UPDATE Student SET dob = '2014-03-03' WHERE student_id = 60"

echo; echo "=== 3c. a new subject named like an existing one: refused (its marks would lose it) ==="
my "INSERT INTO Subject (subject_id,name,exam_total_marks,class_total_marks,exam_percentage,class_percentage,pass_marks) VALUES (3,'mathematics',100,100,70,30,40)"
if $SYNC > "$WORK/subj.log" 2>&1; then cat "$WORK/subj.log"; fail "sync accepted a second Mathematics"; fi
grep -q "Subject: new live row(s) clash with another on uniq_subject_name" "$WORK/subj.log" || { cat "$WORK/subj.log"; fail "subject refusal message"; }
echo "✓ refused"
my "DELETE FROM Subject WHERE subject_id = 3"

COUNTS='SELECT (SELECT count(*) FROM dbo."Fee")||'"'"'/'"'"'||(SELECT count(*) FROM dbo."Student")||'"'"'/'"'"'||(SELECT last_value FROM dbo.receipt_seq)'
BEFORE=$(pg "$COUNTS")

echo; echo "=== 4. dry run ==="
$SYNC --dry-run > "$WORK/dry.log" 2>&1 || { cat "$WORK/dry.log"; fail "dry run"; }
grep -q "^+5 added, ~2 updated, 1 duplicate(s) removed" "$WORK/dry.log" || { cat "$WORK/dry.log"; fail "dry-run summary"; }
expect "dry run saved nothing (fees/pupils/receipt seq)" "$(pg "$COUNTS")" "$BEFORE"

echo; echo "=== 5. sync ==="
$SYNC > "$WORK/s1.log" 2>&1 || { cat "$WORK/s1.log"; fail "sync"; }
cat "$WORK/s1.log"
expect "new payment has the next receipt number, in the year it was paid" "$(pg "SELECT receipt_no FROM dbo.\"Fee\" WHERE fee_id = 3")" "PPS-2026-000003"
expect "new payment has its term (011)" "$(pg "SELECT term_id FROM dbo.\"Fee\" WHERE fee_id = 3")" "2"
expect "pupil 1 owes the live balance" "$(pg "SELECT fees_owing::int||'/'||fees_paid::int||'/'||fees_opening_balance::int||'/'||fees_period_after_fee_id FROM dbo.\"Student\" WHERE student_id = 1")" "300/600/300/3"
expect "new pupil 60 added, not archived, period tied to the active term" "$(pg "SELECT f_name||'/'||is_deleted||'/'||fees_owing::int||'/'||fees_period_term_id FROM dbo.\"Student\" WHERE student_id = 60")" "Esi/false/900/2"
expect "parent phone updated (live wins)" "$(pg "SELECT contact FROM dbo.\"Parent\" WHERE parent_id = 1")" "0209998888"
HASH=$(pg "SELECT password FROM dbo.\"Student\" WHERE student_id = 1")
expect "changed password is hashed and matches" "$($NODE -e "require('bcrypt').compare('newpass9', process.argv[1]).then(ok => console.log(ok))" "$HASH")" "true"
expect "register saved twice: only the latest (id 7) kept" "$(pg "SELECT string_agg(attendance_id::text, ',') FROM dbo.\"Attendance\" WHERE student_id = 1 AND date_marked = '2026-01-08'")" "7"
expect "the replaced register row is in _removed_duplicates" "$(pg "SELECT count(*) FROM dbo._removed_duplicates WHERE table_name = 'Attendance' AND row_data->>'attendance_id' = '2'")" "1"
expect "cleaned-up duplicates stayed out (Attendance 1, marks 2)" "$(pg "SELECT count(*) FROM dbo.\"Attendance\" WHERE attendance_id = 1")/$(pg "SELECT count(*) FROM dbo.\"Student_marks\" WHERE student_marks_id = 2")" "0/0"
expect "new JHS mark has its BECE grade (032)" "$(pg "SELECT grade FROM dbo.\"Student_marks\" WHERE student_marks_id = 8")" "3"
expect "new term is in its school year (029)" "$(pg "SELECT ay.name FROM dbo.\"Term\" t JOIN dbo.\"Academic_year\" ay USING (academic_year_id) WHERE t.term_id = 4")" "2026/2027"
expect "deleted event kept without --mirror-deletes" "$(pg "SELECT count(*) FROM dbo.\"Event\"")" "1"
grep -q "every balance equals live" "$WORK/s1.log" || fail "balance check did not run"
expect "next new pupil id is above live's" "$(pg "SELECT nextval(pg_get_serial_sequence('dbo.\"Student\"', 'student_id'))")" "61"

echo; echo "=== 6. sync again: no change ==="
$SYNC > "$WORK/s2.log" 2>&1 || { cat "$WORK/s2.log"; fail "second sync"; }
grep -q "^+0 added, ~0 updated, 0 duplicate(s) removed" "$WORK/s2.log" || { cat "$WORK/s2.log"; fail "second sync was not a no-op"; }
grep -q '"pupilsRebased":0' "$WORK/s2.log" || { cat "$WORK/s2.log"; fail "second sync re-based balances"; }
echo "✓ no change"

echo; echo "=== 6b. live opens a term in a school year the new database already has ==="
my "UPDATE Term SET active = b'0' WHERE term_id = 2; UPDATE Term SET active = b'1' WHERE term_id = 4"
$SYNC > "$WORK/s2b.log" 2>&1 || { cat "$WORK/s2b.log"; fail "sync after the year switch"; }
expect "exactly one current year, the active term's" "$(pg "SELECT string_agg(name, ',') FROM dbo.\"Academic_year\" WHERE is_current")" "2026/2027"
expect "pupils' fee period follows the active term" "$(pg "SELECT DISTINCT fees_period_term_id FROM dbo.\"Student\"")" "4"
grep -q "every balance equals live" "$WORK/s2b.log" || fail "balances after the year switch"

echo; echo "=== 7. --mirror-deletes ==="
my "DELETE FROM Term WHERE term_id = 1"
$SYNC --mirror-deletes > "$WORK/s3.log" 2>&1 || { cat "$WORK/s3.log"; fail "mirror-deletes"; }
expect "event live deleted is removed" "$(pg "SELECT count(*) FROM dbo.\"Event\"")" "0"
expect "a term live deleted is kept (never removed automatically)" "$(pg "SELECT count(*) FROM dbo.\"Term\" WHERE term_id = 1")" "1"
grep -q "KEPT: terms and payments are never removed automatically" "$WORK/s3.log" || { cat "$WORK/s3.log"; fail "kept-term message"; }

echo; echo "=== 8. new system used: the sync refuses ==="
pg "UPDATE dbo.\"Fee\" SET recorded_by = 'office' WHERE fee_id = 3" >/dev/null
if $SYNC > "$WORK/s4.log" 2>&1; then cat "$WORK/s4.log"; fail "sync ran although the new system was used"; fi
grep -q "payments recorded or reversed in the new system" "$WORK/s4.log" || { cat "$WORK/s4.log"; fail "refusal message"; }
echo "✓ refused"

echo; echo "✓ SYNC REHEARSAL PASSED"
