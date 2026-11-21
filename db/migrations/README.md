# Database migrations

Every schema change goes here as a numbered plain-SQL file (Postgres). There is no `sequelize.sync` in production, so these files are how the live database stays in line with the models.

## Commands
```bash
npm run migrate                # apply all pending files, in order
npm run migrate -- --status    # show applied / pending, change nothing
```
The runner uses the same `DB_*` env vars as the API.

## Rules
- **Names:** `NNN_lower_snake_name.sql`, for example `001_academic_years.sql`. Numbers must be unique, and files run in number order.
- **One transaction per file:** if a file fails, nothing from that file is kept and the run stops.
- **Never edit a file that has been applied anywhere.** Its checksum is stored in `"dbo"."_migrations"`, and the runner refuses to continue if the file changed. To fix a mistake, write a new file.
- **Qualify every table with the schema and quote the names,** matching the model's `tableName`, for example `"dbo"."Student"`. Columns are snake_case (the model `field:` names).
- **Make files safe to re-run where possible:** use `IF NOT EXISTS` / `IF EXISTS`.
- **A new table may already exist when the file runs.** `npm run move-data` (and `devSync`) create every table from the models first, so `CREATE TABLE IF NOT EXISTS` is skipped there. Keep the CREATE to columns and the primary key, then add everything else so it lands either way:
  - defaults with `ALTER COLUMN … SET DEFAULT` (a model's `DataTypes.NOW` gives the column no database default);
  - each CHECK, FK and UNIQUE by name in a `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` block, indexes with `CREATE [UNIQUE] INDEX IF NOT EXISTS name`;
  - seed INSERTs that list every NOT NULL column (`updated_at`, `created_at` too);
  - backfills that check the data (`WHERE x IS NULL`), never assume the column is new.
  `./scripts/rehearse-data-move.sh` checks this end to end.
- **Update the model in `src/models` in the same commit** as the migration.
- **Data backfills belong in the same file as the column they fill,** when they are plain SQL.

## Baseline
The schema that existed before this folder was created comes from the MySQL → Postgres data move (see `DOCKER.md` and `scripts/migrate-from-mysql/`). Migrations start from that baseline.

## Part A / Part B numbering (2026-11-14)

The release is split in two: Part A goes live first (001, 007–009, 011–013, 022), and Part B follows on top of it. Part B's migrations were renumbered so they come after everything Part A applies (the runner refuses a file numbered below one already applied). Contents are unchanged, so checksums are the same; only the file names moved:

| Old | New | | Old | New |
|---|---|---|---|---|
| 002_fee_receipts_and_reversal | 023 | | 015_term_billing | 030 |
| 003_teaching_assignments | 024 | | 016_fee_discounts | 031 |
| 004_timetable | 025 | | 018_grading_scales | 032 |
| 005_promotion | 026 | | 019_photos_and_documents | 033 |
| 006_constraints_after_data_move | 027 | | 020_school_settings | 034 |
| 010_terms_promoted_by_old_system | 028 | | 021_admission_numbers | 035 |
| 014_academic_years | 029 | | | |

Comments inside the SQL files still use the old numbers. A database that applied the old names (only local copies) needs its `dbo._migrations` names updated, e.g. `UPDATE dbo."_migrations" SET name = '023_fee_receipts_and_reversal.sql' WHERE name = '002_fee_receipts_and_reversal.sql';`, or a rebuild.

## B9 / B15 / B17 (2026-11-14)

036 (B9 staff attendance), 037 (B15 news feed) and 039 (B17 photo thumbnails) were built in parallel; 038 is unused. **Merge all three into `feature/part-b` before migrating any database from it.** The runner refuses a pending file numbered below one already applied, so a database that got 039 first would refuse 036 and 037.

## B16 (2026-11-14)

040 (B16 notifications: `User_notification`, `Email_log`, `Notification_setting`) was built on `feature/part-b` alongside B11 / B14 (041 / 042 reserved for them). **040 must ship together with 036 / 037 / 039 on part-b**: merge it before migrating any database from part-b, so no database applies a higher number first and then refuses 040.

## B14 (2026-11-14)

042 (B14 invoices and credit notes) was built alongside 040 (B16) and 041 (reserved for B11, if it needs one). **It ships with 036 / 037 / 039 on `feature/part-b`: merge 040 (and 041, if it exists) together with 042 into `feature/part-b` before migrating any database from it**, for the same reason as above (a database that got 042 first would refuse 040 and 041). 042 creates empty tables and changes no balance. **Apply 042 before starting the B14 code:** every balance change now reads `Invoice` / `Credit_note`, so the API's payments, reversals and billing fail until the tables exist.

## B10 (2026-11-17)

050 (B10 roles and permissions: `Role`, `Role_permission`, `User_account.role_id`) was numbered after the AI branch's 043–046 and 049 (047 and 048 are unused). It seeds the three system roles with fixed ids 1–3 and backfills `role_id` from `category` (exact names only); their permissions live in code (`src/utils/permissions.js`), custom roles' in `Role_permission`. **Apply 050 before starting the B10 code:** sign-in and every office request read `User_account.role_id`. The runner refuses a pending file numbered below one already applied, so **a database that applies 050 before the AI branch's 043–046 / 049 would refuse them**: merge the AI branch first, or keep any database that applied 050 off the AI migrations until it is rebuilt. `npm run sync-data` re-points logins on a system role at live's category (`LOGIN_ROLE_SQL`).

**Before go-live (050):** run `SELECT category, count(*) FROM "dbo"."User_account" GROUP BY 1 ORDER BY 1;` on the moved database. 050 gives a role only to logins whose category is exactly `Administrator`, `Class Teacher` or `Accountant`. Any other value (different case such as `administrator`, trailing spaces such as `Accountant `, or `Head Teacher` from rehearsals) gets **no role and reaches no office page** until an Administrator gives it one on People → Office logins (or `UPDATE "dbo"."User_account" SET role_id = <id>, category = '<role name>' WHERE username = '<exact username>';`). 050 also prints a NOTICE with the count.

**Several API processes (B10):** each process caches a login's role for 30 s and a role's permissions for 60 s. A role change, a login's new role or an archived staff member applies at once in the process that made it and **within 60 s in the others**. Restart the API to apply it everywhere at once.
