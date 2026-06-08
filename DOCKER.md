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
   (`student_id`, `is_deleted`, `date_paid`, `salary_snapshot`, …) — case-sensitive.
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
   `Password_reset_code` index — in Postgres syntax.

## What changed in the code for Postgres
- `src/config/database.js`: dialect `postgres`, added `DB_PORT` (default 5432).
- `package.json`: `pg` + `pg-hstore` replace `mysql2` + `tedious`.
- `src/services/graph.js`: MySQL `YEAR/MONTH/DAYOFMONTH/WEEK()` → Postgres
  `EXTRACT(... FROM ...)` (one shared `buildTimeSeries` helper; filter values are
  `Number()`-coerced because Postgres has no implicit numeric=text compare).
- `src/services/account.js`: feeding/extra-classes/bus-fee date filters → the
  parameterized `buildDateWhere` range (removed MySQL `CONVERT(...)`).
- `src/services/results.js` + `src/services/user.js`: raw SQL ported —
  `` `dbo.Table` `` (MySQL) → `"dbo"."Table"` with table aliases (Postgres rejects
  `schema.table.column`), camelCase output aliases double-quoted to preserve case,
  and `DATE_FORMAT(date,'%Y')` → `to_char(date,'YYYY')`.
- `Op.like` → `Op.iLike` for name searches (Postgres `LIKE` is case-sensitive).

> The raw-SQL endpoints (student marks/results detail, nursery results, teacher
> details) and the chart endpoints should be smoke-tested once real data is
> loaded — raw SQL couldn't be validated against an empty schema.
