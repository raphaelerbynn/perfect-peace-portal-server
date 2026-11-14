// MySQL (live) -> PostgreSQL data move (Phase 0.4.4).
//
//   SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run move-data -- --dry-run
//   SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run move-data
//
// The target is the normal API database (DB_* env vars). Steps:
//   1. Creates the "dbo" schema and every table from the Sequelize models, so
//      names, case and types (BOOLEAN, NUMERIC, SERIAL) match the app exactly.
//   2. Copies every table in ONE transaction: foreign keys are dropped for the
//      load and re-added afterwards, values are converted (TINYINT/BIT ->
//      boolean, zero dates -> NULL), plaintext passwords are bcrypt-hashed, and
//      new NOT NULL columns (is_deleted …) get their defaults.
//   3. Resets every id sequence to MAX(id)+1.
//   4. Re-validates foreign keys and reports orphans, reports duplicates that
//      would block db/migrations/001, and compares row counts.
//   5. Writes a JSON report (db/move-reports/).
// --dry-run reads the source only and writes nothing to Postgres.
// The target must be empty: the script refuses to load over existing rows.
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import "../models/index.js";
import {
  UNIQUE_KEYS,
  duplicateSql,
  loadOrder,
  roundingRisks,
  rowProblems,
  transformRows,
} from "../utils/dataMove.js";
import {
  SCHEMA,
  analyse,
  assertSafeTarget,
  connectSource,
  foreignKeys,
  myQ,
  pgQ,
  pgTable,
  resetSequences,
  sourceAutoIncrement,
} from "./lib/mysqlMove.js";
import { NEW_ROW_TABLES, SYNC_STATE_DDL, saveSyncStateSql } from "../utils/dataSync.js";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 500;
const BCRYPT_ROUNDS = 10;
const log = (...a) => console.log(...a);

const sourceColumnTypes = async (my, table) => {
  const [rows] = await my.query(`SHOW COLUMNS FROM ${myQ(table)}`);
  return Object.fromEntries(rows.map((r) => [r.Field, r.Type]));
};

// Values with a decimal part in columns the target stores as whole numbers.
const roundingReport = async (my, plan) => {
  const out = [];
  for (const p of plan.filter((x) => x.source)) {
    for (const r of roundingRisks(p.map, await sourceColumnTypes(my, p.source))) {
      const [[{ n }]] = await my.query(
        `SELECT COUNT(*) AS n FROM ${myQ(p.source)} WHERE ${myQ(r.source)} IS NOT NULL AND ${myQ(r.source)} <> ROUND(${myQ(r.source)})`
      );
      if (Number(n) > 0) out.push({ table: p.table, column: r.target, sourceType: r.sourceType, targetType: r.targetType, rows: Number(n) });
    }
  }
  if (out.length) {
    log("\n! Decimal values that the target stores as whole numbers (would be ROUNDED):");
    out.forEach((o) => log(`  ${o.table}.${o.column}: ${o.rows} row(s), ${o.sourceType} -> ${o.targetType}`));
  } else {
    log("✓ No decimal values would be rounded.");
  }
  return out;
};

// Values that would make the real move abort (it is one transaction: one bad
// row undoes everything on go-live day). Read-only; reports, never fixes.
const valueReport = async (my, plan) => {
  const out = [];
  for (const p of plan.filter((x) => x.source)) {
    const [rows] = await my.query(`SELECT * FROM ${myQ(p.source)}`);
    for (const f of rowProblems(rows, p.map)) out.push({ table: p.table, ...f });
  }
  if (out.length) {
    log("\n! Values the move would REFUSE (fix them in the source copy first):");
    out.forEach((o) => log(`  ${o.table}.${o.column}: ${o.rows} row(s) ${o.problem}${o.sample != null ? ` (e.g. ${JSON.stringify(o.sample)})` : ""}`));
  } else {
    log("✓ Every value fits the new schema.");
  }
  return out;
};

const sourceDuplicates = async (my, plan) => {
  const out = [];
  for (const key of UNIQUE_KEYS) {
    const p = plan.find((x) => x.table === key.table && x.source);
    if (!p) continue;
    const missing = key.columns.filter(
      (c) => !c.includes("(") && !p.map.copy.some((m) => m.target === c)
    );
    if (missing.length) continue;
    const [rows] = await my.query(duplicateSql(key, myQ, myQ(p.source)));
    if (rows.length) out.push({ index: key.index, table: key.table, groups: rows });
  }
  return out;
};

// ---------------------------------------------------------------- target
const assertTargetEmpty = async (models) => {
  const nonEmpty = [];
  for (const model of models) {
    const [[{ exists }]] = await sequelize.query(
      "SELECT to_regclass(:t) IS NOT NULL AS exists",
      { replacements: { t: pgTable(model.tableName) } }
    );
    if (!exists) continue;
    const [[{ n }]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM ${pgTable(model.tableName)}`);
    if (n > 0) nonEmpty.push(`${model.tableName} (${n} rows)`);
  }
  if (nonEmpty.length) {
    throw new Error(
      `Target database is not empty: ${nonEmpty.join(", ")}. ` +
        "Load into a fresh database (or drop the dbo schema first)."
    );
  }
};

const createTables = async (models) => {
  await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  let pending = [...models];
  for (let pass = 1; pending.length && pass <= 10; pass++) {
    const still = [];
    for (const m of pending) {
      try {
        await m.sync();
      } catch (e) {
        still.push(m);
      }
    }
    if (still.length === pending.length) {
      throw new Error(`Could not create tables: ${still.map((m) => m.tableName).join(", ")}`);
    }
    pending = still;
  }
  // The models declare some of 001's unique indexes (uniq_attendance,
  // uniq_total_attendance); sync() created them, so one duplicate row in live
  // data would abort the whole move. Drop them: duplicates load, are reported,
  // and migration 001 creates the indexes after they are cleaned up.
  for (const key of UNIQUE_KEYS) {
    await sequelize.query(`DROP INDEX IF EXISTS ${SCHEMA}.${pgQ(key.index)}`);
  }
};

const load = async (my, plan) => {
  const qi = sequelize.getQueryInterface();
  const hash = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
  const loaded = {};
  const changes = {};
  let fks = [];

  await sequelize.transaction(async (transaction) => {
    fks = await foreignKeys(transaction);
    for (const fk of fks) {
      await sequelize.query(
        `ALTER TABLE ${pgTable(fk.table)} DROP CONSTRAINT ${pgQ(fk.name)}`,
        { transaction }
      );
    }

    for (const p of plan) {
      if (!p.source) continue;
      const [rows] = await my.query(`SELECT * FROM ${myQ(p.source)}`);
      const stats = { defaulted: {}, passwordsHashed: 0 };
      const target = await transformRows(rows, p.map, {
        table: p.table,
        attributes: p.model.getAttributes(),
        hash,
        stats,
      });
      if (stats.passwordsHashed || Object.keys(stats.defaulted).length) {
        changes[p.table] = stats;
      }
      for (let i = 0; i < target.length; i += BATCH) {
        await qi.bulkInsert(
          { tableName: p.table, schema: SCHEMA },
          target.slice(i, i + BATCH),
          { transaction }
        );
      }
      loaded[p.table] = target.length;
      log(`  ${p.table.padEnd(22)} ${String(target.length).padStart(7)} rows`);
    }

    // Re-add the keys without checking old rows, so legacy orphans (e.g. a
    // student whose class was hard-deleted years ago) don't abort the move.
    // New writes are still checked; old rows are validated below.
    for (const fk of fks) {
      await sequelize.query(
        `ALTER TABLE ${pgTable(fk.table)} ADD CONSTRAINT ${pgQ(fk.name)} ${fk.def} NOT VALID`,
        { transaction }
      );
    }
    await resetSequences(plan.map((p) => p.model), transaction, await sourceAutoIncrement(my, plan));
  });

  // Outside the load transaction: try to fully validate each key.
  const orphans = [];
  for (const fk of fks) {
    try {
      await sequelize.query(`ALTER TABLE ${pgTable(fk.table)} VALIDATE CONSTRAINT ${pgQ(fk.name)}`);
    } catch (e) {
      orphans.push({ table: fk.table, constraint: fk.name, definition: fk.def, error: e.message });
    }
  }
  return { loaded, orphans, changes };
};

// For the top-up sync (npm run sync-data): the highest id each table had when
// it was copied, so a row typed into the new system later is recognised.
const recordSyncState = async (plan) => {
  await sequelize.query(SYNC_STATE_DDL);
  for (const p of plan.filter((x) => x.source && NEW_ROW_TABLES.has(x.table))) {
    const pk = p.model.getAttributes()[p.model.primaryKeyAttributes[0]].field;
    const [[{ n }]] = await sequelize.query(`SELECT COALESCE(MAX(${pgQ(pk)}), 0)::bigint AS n FROM ${pgTable(p.table)}`);
    await sequelize.query(saveSyncStateSql, { replacements: { table: p.table, maxId: Number(n) } });
  }
};

const targetDuplicates = async () => {
  const out = [];
  for (const key of UNIQUE_KEYS) {
    const [rows] = await sequelize.query(duplicateSql(key, pgQ, pgTable(key.table)));
    if (rows.length) out.push({ index: key.index, table: key.table, groups: rows });
  }
  return out;
};

// Fees: migration 008 keeps every pupil's live balance as their opening
// balance, so go-live changes nobody's balance. For the office's information,
// report classes with pupils but no ClassFee rows (fee edits there won't add
// anything) and how many stored balances differ from "fee rows - all payments"
// (expected: live resets on class changes; not an error).
const feeDrift = async () => {
  const [noFeeRows] = await sequelize.query(`
    SELECT c.name, COUNT(s.student_id)::int AS pupils
    FROM ${pgTable("Class")} c
    JOIN ${pgTable("Student")} s ON s.class_id = c.class_id AND s.is_deleted IS NOT TRUE
    WHERE c.is_deleted IS NOT TRUE
      AND NOT EXISTS (SELECT 1 FROM ${pgTable("ClassFee")} f WHERE f.class_id = c.class_id)
    GROUP BY c.name ORDER BY c.name`);
  const [drift] = await sequelize.query(`
    WITH billed AS (
      SELECT s.student_id, s.fees_owing AS cached,
        GREATEST(0,
          COALESCE((SELECT SUM(amount) FROM ${pgTable("ClassFee")} cf WHERE cf.class_id = s.class_id), 0)
        + COALESCE((SELECT SUM(amount) FROM ${pgTable("StudentFee")} sf WHERE sf.student_id = s.student_id), 0)
        - COALESCE((SELECT SUM(paid) FROM ${pgTable("Fee")} f WHERE f.student_id = s.student_id AND f.reversed_at IS NULL), 0)) AS recomputed
      FROM ${pgTable("Student")} s WHERE s.is_deleted IS NOT TRUE)
    SELECT COUNT(*)::int AS pupils, COALESCE(SUM(ABS(cached - recomputed)), 0)::numeric AS total_difference
    FROM billed WHERE COALESCE(cached, 0) <> recomputed`);
  const out = { classesWithoutFeeRows: noFeeRows, balancesDifferingFromFeeRows: drift[0]?.pupils ?? 0, totalDifference: Number(drift[0]?.total_difference ?? 0) };
  if (noFeeRows.length) log(`i Classes with pupils but no ClassFee rows (set their fees in the app): ${noFeeRows.map((r) => `${r.name} (${r.pupils})`).join(", ")}`);
  log(
    `i ${out.balancesDifferingFromFeeRows} stored balance(s) differ from "fee rows - all payments" (GHc ${out.totalDifference}). ` +
      "They are kept as opening balances by migration 008: nobody's balance changes at go-live."
  );
  return out;
};

const targetCounts = async (plan) => {
  const out = {};
  for (const p of plan) {
    const [[{ n }]] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM ${pgTable(p.table)}`);
    out[p.table] = n;
  }
  return out;
};

// ---------------------------------------------------------------- report
const writeReport = (report) => {
  const dir = path.resolve(process.cwd(), "db/move-reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${DRY_RUN ? "dry-run" : "move"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
};

const summarisePlan = (plan, unmappedSourceTables) => {
  const missing = plan.filter((p) => !p.source).map((p) => p.table);
  if (missing.length) log(`\nNo source table (starts empty): ${missing.join(", ")}`);
  if (unmappedSourceTables.length) {
    log(`Source tables NOT copied (no model): ${unmappedSourceTables.join(", ")}`);
  }
  for (const p of plan.filter((x) => x.source && x.map.sourceOnly.length)) {
    log(`Columns NOT copied from ${p.source}: ${p.map.sourceOnly.join(", ")}`);
  }
};

const main = async () => {
  assertSafeTarget({ dryRun: DRY_RUN });
  const my = await connectSource();
  const models = loadOrder(Object.values(sequelize.models));
  const report = { mode: DRY_RUN ? "dry-run" : "move", startedAt: new Date().toISOString() };

  try {
    await sequelize.authenticate();
    log(`Source: MySQL ${my.config.database} -> Target: Postgres ${sequelize.getDatabaseName()}`);
    const { plan, unmappedSourceTables } = await analyse(my, models);

    report.tables = plan.map((p) => ({
      table: p.table,
      source: p.source,
      sourceRows: p.sourceRows ?? 0,
      columnsNotCopied: p.map?.sourceOnly ?? [],
      columnsDefaulted: p.map?.targetOnly ?? [],
    }));
    report.unmappedSourceTables = unmappedSourceTables;
    summarisePlan(plan, unmappedSourceTables);
    report.rounding = await roundingReport(my, plan);

    if (DRY_RUN) {
      report.duplicates = await sourceDuplicates(my, plan);
      report.valueProblems = await valueReport(my, plan);
      log("\nRows per table (source):");
      plan.filter((p) => p.source).forEach((p) =>
        log(`  ${p.table.padEnd(22)} ${String(p.sourceRows).padStart(7)}`)
      );
    } else {
      await assertTargetEmpty(models);
      log("\nCreating tables …");
      await createTables(models);
      log("Copying rows …");
      const { loaded, orphans, changes } = await load(my, plan);
      report.loaded = loaded;
      await recordSyncState(plan);
      report.changes = changes;
      report.orphans = orphans;
      report.duplicates = await targetDuplicates();

      const counts = await targetCounts(plan);
      report.countMismatches = plan
        .filter((p) => p.source && counts[p.table] !== p.sourceRows)
        .map((p) => ({ table: p.table, source: p.sourceRows, target: counts[p.table] }));
      report.fees = await feeDrift();
    }

    report.finishedAt = new Date().toISOString();
    const file = writeReport(report);

    log("\n=== Result ===");
    if (report.countMismatches?.length) {
      log(`✗ Row counts differ: ${JSON.stringify(report.countMismatches)}`);
    } else if (!DRY_RUN) {
      log("✓ Row counts match for every table.");
    }
    for (const [table, c] of Object.entries(report.changes || {})) {
      if (c.passwordsHashed) log(`· ${table}: ${c.passwordsHashed} plaintext password(s) hashed`);
      for (const [col, n] of Object.entries(c.defaulted)) {
        log(`· ${table}.${col}: ${n} NULL value(s) set to the column default`);
      }
    }
    if (report.orphans?.length) {
      log(`! ${report.orphans.length} foreign key(s) have orphan rows (kept, NOT VALID): ` +
        report.orphans.map((o) => `${o.table}.${o.constraint}`).join(", "));
    }
    if (report.duplicates.length) {
      log(`! Duplicates block migration 001 in: ${report.duplicates.map((d) => d.index).join(", ")}`);
      log("  Clean these up before running `npm run migrate`.");
    } else {
      log("✓ No duplicates — `npm run migrate` can create the unique indexes.");
    }
    log(`Report: ${file}`);
    process.exitCode = report.countMismatches?.length ? 1 : 0;
  } finally {
    await my.end();
    await sequelize.close();
  }
};

main().catch((err) => {
  console.error(`Data move failed: ${err.message}`);
  if (!err.message.startsWith("Refusing")) {
    console.error("No rows were committed. Empty tables may have been created; drop the dbo schema before retrying.");
  }
  process.exit(1);
});
