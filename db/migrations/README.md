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
