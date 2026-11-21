import crypto from "crypto";
import fs from "fs";
import path from "path";

// Plain-SQL migration runner helpers (Phase 0.4.3).
//
// Files live in db/migrations/ and are named NNN_short_name.sql (e.g.
// 001_academic_years.sql). They run in filename order, each inside its own
// transaction, and are recorded in "dbo"."_migrations" with a checksum.
// A file that was already applied must never be edited: the checksum check
// refuses to continue if it changed. Write a new file instead.

const MIGRATION_FILE = /^(\d{3,})_[a-z0-9_]+\.sql$/;
const MIGRATIONS_TABLE = '"dbo"."_migrations"';

const checksum = (sql) =>
  crypto.createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

// Read and validate the migration files in `dir`, sorted by number.
const readMigrationFiles = (dir) => {
  // A missing folder means a broken deploy (e.g. a Docker image without db/),
  // not "nothing to do": say so instead of reporting "No pending migrations".
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations folder not found: ${dir}. Run from the server folder (or copy db/ into the image).`);
  }
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));

  const bad = names.filter((f) => !MIGRATION_FILE.test(f));
  if (bad.length) {
    throw new Error(
      `Badly named migration file(s): ${bad.join(", ")}. Use NNN_lower_snake_name.sql`
    );
  }

  const seen = new Map();
  for (const f of names) {
    const num = f.match(MIGRATION_FILE)[1];
    if (seen.has(num)) {
      throw new Error(`Duplicate migration number ${num}: ${seen.get(num)} and ${f}`);
    }
    seen.set(num, f);
  }

  return names
    .sort((a, b) => Number(a.match(MIGRATION_FILE)[1]) - Number(b.match(MIGRATION_FILE)[1]))
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: checksum(sql) };
    });
};

// Compare files on disk with rows already recorded. Returns the files still to
// run. Throws if an applied file was edited or deleted (history must not change).
const planMigrations = (files, applied) => {
  const byName = new Map(files.map((f) => [f.name, f]));

  for (const row of applied) {
    const file = byName.get(row.name);
    if (!file) {
      throw new Error(
        `Migration ${row.name} is recorded as applied but its file is missing.`
      );
    }
    if (file.checksum !== row.checksum) {
      throw new Error(
        `Migration ${row.name} was edited after it was applied. ` +
          "Revert the edit and put the change in a new migration file."
      );
    }
  }

  const appliedNames = new Set(applied.map((r) => r.name));
  const pending = files.filter((f) => !appliedNames.has(f.name));

  // A file numbered below one already applied was added out of order (e.g. two
  // branches both used 006). Running it now could depend on schema the later
  // files changed, so stop and make the author renumber it.
  const num = (n) => Number(n.match(MIGRATION_FILE)?.[1] ?? 0);
  const highest = Math.max(0, ...applied.map((r) => num(r.name)));
  const early = pending.filter((f) => num(f.name) < highest);
  if (early.length) {
    throw new Error(
      `Migration ${early.map((f) => f.name).join(", ")} is numbered below one already applied ` +
        `(${applied.find((r) => num(r.name) === highest)?.name}). Renumber it after the latest.`
    );
  }
  return pending;
};

// Key for pg_advisory_xact_lock: one migration run at a time.
const MIGRATION_LOCK = 4_204_242;

const ensureMigrationsTable = (sequelize) =>
  sequelize.query(`
    CREATE SCHEMA IF NOT EXISTS dbo;
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       VARCHAR(255) PRIMARY KEY,
      checksum   CHAR(64)     NOT NULL,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
  `);

const appliedMigrations = async (sequelize) => {
  const [rows] = await sequelize.query(
    `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`
  );
  return rows;
};

// Apply every pending migration. Each file and its bookkeeping row commit
// together, so a failing file leaves nothing half-applied and stops the run.
const runMigrations = async (sequelize, dir, { log = console.log } = {}) => {
  await ensureMigrationsTable(sequelize);
  const pending = planMigrations(readMigrationFiles(dir), await appliedMigrations(sequelize));

  if (!pending.length) {
    log("No pending migrations.");
    return [];
  }

  const done = [];
  for (const m of pending) {
    const ran = await sequelize.transaction(async (transaction) => {
      // Two runs at once (e.g. two containers starting) wait here; the second
      // then sees the file recorded and skips it instead of applying it twice.
      await sequelize.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`, { transaction });
      const [already] = await sequelize.query(`SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE name = :name`, {
        replacements: { name: m.name },
        transaction,
      });
      if (already.length) return false;
      log(`Applying ${m.name} …`);
      await sequelize.query(m.sql, { transaction });
      await sequelize.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES (:name, :checksum)`,
        { replacements: { name: m.name, checksum: m.checksum }, transaction }
      );
      return true;
    });
    if (ran) done.push(m.name);
  }
  log(`Applied ${done.length} migration(s).`);
  return done;
};

export {
  MIGRATION_FILE,
  checksum,
  readMigrationFiles,
  planMigrations,
  ensureMigrationsTable,
  appliedMigrations,
  runMigrations,
};
