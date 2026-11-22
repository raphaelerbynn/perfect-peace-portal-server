# Running the backend in Docker (PostgreSQL)

The backend was migrated from MySQL to **PostgreSQL**. This compose stack runs the
API + a Postgres database + pgAdmin.

## Quick start

```bash
cp .env.example .env        # then fill in JWT_KEY, ARKESEL_KEY, DB_* , etc.
docker compose up -d --build
```

- API:      http://localhost:5050  (override with `SERVER_PORT`)
- pgAdmin:  http://localhost:5051  (login from `PGADMIN_EMAIL` / `PGADMIN_PASSWORD`)
- Postgres: localhost:5432 from the host; `db:5432` from inside the compose network
- MinIO (B17 files): console http://localhost:9001, S3 API localhost:9000 (both bound to 127.0.0.1; login `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, dev defaults `ppminio` / `ppminio-dev-password`). The API creates the private bucket `perfect-peace` on start. Use `STORAGE_DRIVER=local` to keep files on disk instead.
  The official `minio/minio` image can no longer be pulled, so compose uses `cgr.dev/chainguard/minio:latest` (`MINIO_IMAGE` to change it).
  Check against a real MinIO: `PP_MINIO_LIVE=1 S3_ENDPOINT=http://127.0.0.1:9000 npx jest src/__tests__/live/minio.live.test.js`.

The `.env` file is used BOTH for compose `${VAR}` interpolation AND as the backend
container's env. Compose overrides `DB_HOST=db`, `DB_PORT=5432`, `SERVER_PORT=5050`
for the backend container regardless of what `.env` says, so the app always reaches
the `db` service.

## Connecting pgAdmin to the database
Add a server in pgAdmin → Host `db`, Port `5432`, Maintenance DB / user / password =
your `DB_NAME` / `DB_USERNAME` / `DB_PASSWORD`.

## Loading your data
Your data-move script runs **separately** against the live container, e.g.:
```bash
# from the host, against the mapped port:
psql "postgresql://$DB_USERNAME:$DB_PASSWORD@localhost:5432/$DB_NAME" -f your-migration.sql
# or exec into the db container:
docker compose exec db psql -U "$DB_USERNAME" -d "$DB_NAME" -f /path/in/container.sql
```

`db/init/01-create-schema.sql` runs ONCE on first volume init and only does
`CREATE SCHEMA IF NOT EXISTS dbo;`. Everything else (tables + data) is your script.

## Moving the live MySQL data (use the tool)

`npm run move-data` does everything in the checklist below for you. It is tested by `./scripts/rehearse-data-move.sh`.

```bash
# 1. Rehearse with throwaway Docker databases. With no argument it uses fake data;
#    pass a real mysqldump to rehearse with live data:
./scripts/rehearse-data-move.sh /path/to/live-dump.sql

# 2. For real, into an EMPTY Postgres (DB_* env vars), reading live MySQL:
SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run move-data -- --dry-run
SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run move-data
npm run migrate          # unique indexes etc. Fix any duplicates the move reported first.
```

The tool:
- creates the tables from the models
- copies every table in one transaction
- converts booleans and zero dates
- **bcrypt-hashes plaintext passwords** (Student, Teacher, User_account)
- fills new NOT NULL columns with their defaults
- resets id sequences
- reports orphan rows, duplicates and row-count mismatches, and writes a JSON report to `db/move-reports/`

Use Node 20 (`.nvmrc`). On Node ≥ 25, `jsonwebtoken` fails to load.

## After the move: office logins' roles (B10, migration 050)

After `npm run migrate`, check every office login got a role:

```sql
SELECT category, count(*) FROM "dbo"."User_account" GROUP BY 1 ORDER BY 1;
SELECT username, category FROM "dbo"."User_account" WHERE role_id IS NULL;
```

Only categories that are exactly `Administrator`, `Class Teacher` or `Accountant` get a role. Anything else (other case, trailing spaces, `Head Teacher` from rehearsals) reaches no office page until it is given a role on People → Office logins. With more than one API process, role changes reach the other processes within 60 s (restart to apply at once). See `db/migrations/README.md`.

## ⚠️ What your data-move script MUST produce (so the ORM + raw queries work)

The Sequelize models are pinned to **`schema: 'dbo'`**, and Postgres is
**case-sensitive** for quoted identifiers (Sequelize quotes everything). So:

1. **Schema:** all tables live in the **`dbo`** schema (`"dbo"."Student"`, …).
2. **Exact table names / case** as the models declare them, e.g.
   `Student`, `Teacher`, `Class`, `Subject`, `Student_marks`, `Student_result`,
   `KG_assessment`, `Attendance`, `Total_attendance`, `Salary`, `Salary_payment`,
   `Allowance`, `Deductions`, `Tax`, `EmployeeSalary`, `Fee`, `ClassFee`,
   `StudentFee`, `Income`, `Expense`, `AccountCategory`, `Term`, `Parent`,
   `Notification`, `Event`, `FeeCheck`, `FeedingFee`, `BusFee`, `ExtraClasses`,
   `Password_reset_code`. (Verify each against `src/models/*.js` `tableName`.)
3. **Column names** are the snake_case `field:` mappings in the models
   (`student_id`, `is_deleted`, `date_paid`, `salary_snapshot`, …) - case-sensitive.
4. **Booleans:** `is_deleted`, `Term.active`, etc. must be Postgres `BOOLEAN`
   (MySQL `TINYINT(1)` → `BOOLEAN`). The ORM passes real `true/false`.
5. **Auto-increment PKs:** use `GENERATED ... AS IDENTITY` / `SERIAL`, and after
   bulk-loading rows **reset each sequence** to `MAX(id)+1`, e.g.
   `SELECT setval(pg_get_serial_sequence('"dbo"."Student"','student_id'), MAX(student_id)) FROM "dbo"."Student";`
   otherwise new inserts collide on the PK.
6. **Money columns** (`DECIMAL(18,0)`) → `NUMERIC(18,0)` (or integer).
7. **Re-create the composite UNIQUE indexes** from the feature work (see the
   deploy/cutover notes): `uniq_marks`, `uniq_result`, `uniq_kg`,
   `uniq_attendance`, `uniq_total_attendance`, `uniq_subject_name`, and the
   `Password_reset_code` index - in Postgres syntax.

## What changed in the code for Postgres
- `src/config/database.js`: dialect `postgres`, added `DB_PORT` (default 5432).
- `package.json`: `pg` + `pg-hstore` replace `mysql2` + `tedious`.
- `src/services/graph.js`: MySQL `YEAR/MONTH/DAYOFMONTH/WEEK()` → Postgres
  `EXTRACT(... FROM ...)` (one shared `buildTimeSeries` helper; filter values are
  `Number()`-coerced because Postgres has no implicit numeric=text compare).
- `src/services/account.js`: feeding/extra-classes/bus-fee date filters → the
  parameterized `buildDateWhere` range (removed MySQL `CONVERT(...)`).
- `src/services/results.js` + `src/services/user.js`: raw SQL ported -
  `` `dbo.Table` `` (MySQL) → `"dbo"."Table"` with table aliases (Postgres rejects
  `schema.table.column`), camelCase output aliases double-quoted to preserve case,
  and `DATE_FORMAT(date,'%Y')` → `to_char(date,'YYYY')`.
- `Op.like` → `Op.iLike` for name searches (Postgres `LIKE` is case-sensitive).

> The raw-SQL endpoints (student marks/results detail, nursery results, teacher
> details) and the chart endpoints should be smoke-tested once real data is
> loaded - raw SQL couldn't be validated against an empty schema.
