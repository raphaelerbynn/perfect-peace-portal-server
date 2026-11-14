// Apply pending SQL migrations from db/migrations (Phase 0.4.3).
//
//   npm run migrate            apply everything that has not run yet
//   npm run migrate -- --status   list applied and pending files, change nothing
//
// Uses the same DB_* env vars as the API (see .env.example).
import path from "path";
import sequelize from "../config/database.js";
import {
  appliedMigrations,
  ensureMigrationsTable,
  planMigrations,
  readMigrationFiles,
  runMigrations,
} from "../utils/migrations.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");

const status = async () => {
  await ensureMigrationsTable(sequelize);
  const applied = await appliedMigrations(sequelize);
  const pending = planMigrations(readMigrationFiles(MIGRATIONS_DIR), applied);
  console.log("Applied:");
  applied.forEach((r) => console.log(`  ✓ ${r.name}  (${new Date(r.applied_at).toISOString()})`));
  if (!applied.length) console.log("  (none)");
  console.log("Pending:");
  pending.forEach((m) => console.log(`  • ${m.name}`));
  if (!pending.length) console.log("  (none)");
};

const main = async () => {
  try {
    await sequelize.authenticate();
    console.log(`Database: ${sequelize.getDatabaseName()}`);
    if (process.argv.includes("--status")) {
      await status();
    } else {
      await runMigrations(sequelize, MIGRATIONS_DIR);
    }
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    // Sequelize wraps Postgres errors ("Validation error"); show the real one.
    const pg = err.parent || err.original;
    console.error(`Migration failed: ${pg?.message || err.message}`);
    if (pg?.detail) console.error(`  ${pg.detail}`);
    await sequelize.close().catch(() => {});
    process.exit(1);
  }
};

main();
