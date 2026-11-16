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

## AI-0 (2026-11-16)

043 (AI-0 shared AI infrastructure: `Ai_usage_log`, `Ai_suggestion`, `Ai_settings` with its one row, switched off) was built on `feature/ai-work` from `feature/part-b`. 044–046 are reserved for the AI features built on it (AI-1, AI-3, AI-5 / AI-8). It creates new tables only and changes no existing data. **Merge 043 into `feature/part-b` before 044–046, and before migrating any database from it**, for the same reason as above. Until 043 is applied the API still starts: AI reads as switched off.

## AI-5 (2026-11-16)

046 (AI-5 Monday briefing: `Ai_briefing`, one row per day with `run_key` UNIQUE, and `Ai_briefing_settings` with its one row, Mondays 06:00, email and WhatsApp off) was built on `feature/ai-5-work` from `feature/ai-work`. New tables only; no existing data changes. It needs 043 first and ships with 044 / 045 (AI-1, AI-3): **merge all of 043–046 into `feature/part-b` before migrating any database from it**, for the same reason as above. Until 046 is applied the API still starts: the briefing settings read as their defaults, and the briefing endpoints fail (the timer logs it and tries again the next minute).
