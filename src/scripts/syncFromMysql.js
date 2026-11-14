// Top-up sync: live MySQL (old system, READ ONLY) -> the new Postgres, BEFORE
// go-live, while the new system is loaded but nobody uses it yet.
//
//   SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run sync-data -- --dry-run
//   SOURCE_MYSQL_URL=mysql://user:pass@host:3306/dbo npm run sync-data
//   … npm run sync-data -- --mirror-deletes      also remove rows live deleted
//   … npm run sync-data -- --target=<DB_NAME>    a non-local target (like move-data)
//
// The target must already hold an earlier `npm run move-data` + clean-up +
// `npm run migrate`. For every table the old system has, in one transaction:
//   - rows missing in the new database are added (same ids as live);
//   - rows whose values changed in live are updated: LIVE WINS, but only on
//     columns live has. Columns the new system added (receipt numbers, photos,
//     admission numbers, fee periods, grades …) are kept or recomputed;
//   - duplicates are avoided: ids the duplicate clean-up removed never come
//     back, and a new row that clashes with another on a unique key (a register
//     saved twice …) keeps only the most recent save, as the clean-up does;
//     removed rows are kept in dbo._removed_duplicates. Only for registers,
//     totals, marks, results and KG rows: a clashing subject is refused;
//   - rows live no longer has are listed (removed only with --mirror-deletes:
//     soft-deleted where the table has is_deleted, deleted otherwise; terms
//     and payments are never removed automatically). "Not in live" also means
//     rows created in the new system (an office login, a term set up early),
//     so read the dry run's list before using --mirror-deletes;
//   - tables only the new system has (settings, grading scales, timetable …)
//     are never touched.
// Then what the migrations computed from the data is redone for the changed
// rows (023 receipt year, 011 payment term, 028/029 terms and years, 032 JHS
// grades) and every pupil's fee period is re-based on their live balance
// (008/030/022). Finally the app's own balance calculation runs for every
// pupil; if any balance differs from live, everything is rolled back.
//
// Refuses to run when the new database has been used (payments, registers,
// marks, bills, promotions, discounts or salaries entered in the new system).
// --dry-run does all of it and then rolls back, so it shows exactly what a
// real run would do.
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import "../models/index.js";
import { recomputeStudentOwing } from "../services/fee.js";
import { PASSWORD_TABLES, coerceValue, loadOrder, rowProblems, transformRows } from "../utils/dataMove.js";
import {
  CAND,
  NEW_ROW_TABLES,
  NO_MIRROR_DELETE_TABLES,
  REPLACEABLE_DUPLICATE_TABLES,
  clashSql,
  FEE_RECEIPT_YEAR_SQL,
  FEE_TERM_SQL,
  IDENTITY_COLUMNS,
  LIVE,
  LIVE_FIXUPS,
  MARK_GRADE_SQLS,
  NEW_SYSTEM_ACTIVITY,
  REBASE_STUDENTS_SQL,
  TERM_PROMOTED_SQL,
  TERM_YEAR_SQLS,
  activityProblems,
  candidatesSql,
  changedCountSql,
  dedupeSqls,
  identityClashSql,
  insertSql,
  liveMaxSql,
  newRowsSql,
  saveSyncStateSql,
  SYNC_STATE_DDL,
  onlyInTargetSql,
  q,
  resolvePassword,
  skipRemovedSql,
  uniqueKeysFor,
  updateSql,
} from "../utils/dataSync.js";
import {
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

const DRY_RUN = process.argv.includes("--dry-run");
const MIRROR_DELETES = process.argv.includes("--mirror-deletes");
const BATCH = 500;
const BCRYPT_ROUNDS = 10;
const log = (...a) => console.log(...a);

class DryRunRollback extends Error {}
class Refused extends Error {}

const run = (sql, transaction, replacements) =>
  sequelize.query(sql, { transaction, ...(replacements ? { replacements } : {}) }).then(([rows]) => rows);

const ids = (rows) => rows.map((r) => r.id);

// ---------------------------------------------------------------- before
const assertTargetMigrated = async () => {
  const [[{ ok }]] = await sequelize.query(`SELECT to_regclass('"dbo"."_migrations"') IS NOT NULL AS ok`);
  if (!ok) throw new Refused("The target has no migrations: run `npm run move-data`, the clean-up and `npm run migrate` first.");
  const [pending] = await sequelize.query(`SELECT COUNT(*)::int AS n FROM "dbo"."_migrations"`);
  if (!pending[0].n) throw new Refused("The target has no migrations applied: run `npm run migrate` first.");
};

const assertNewSystemUnused = async () => {
  const counts = [];
  for (const a of NEW_SYSTEM_ACTIVITY) {
    const [[{ exists }]] = await sequelize.query("SELECT to_regclass(:t) IS NOT NULL AS exists", {
      replacements: { t: pgTable(a.table) },
    });
    counts.push(exists ? (await sequelize.query(a.sql))[0][0].n : 0);
  }
  const problems = activityProblems(counts);
  if (problems.length) {
    throw new Refused(
      "The new system has already been used, so live can't simply win:\n" +
        problems.map((p) => `  - ${p.rows} ${p.what}`).join("\n") +
        "\nThe sync is only for before go-live. After go-live the new system is the one to use."
    );
  }
};

// ---------------------------------------------------------------- one table
const loadLiveRows = async (p, pk, transaction, stats) => {
  const [rows] = await p.my.query(`SELECT * FROM ${myQ(p.source)}`);
  const attributes = p.model.getAttributes();

  // Keep an existing hash when it still matches the live (plaintext) password.
  if (PASSWORD_TABLES.has(p.table)) {
    const pwSource = p.map.copy.find((c) => c.target === "password")?.source;
    const pkSource = p.map.copy.find((c) => c.target === pk)?.source;
    if (pwSource && pkSource) {
      const existing = new Map(
        (await run(`SELECT ${q(pk)}::text AS id, password FROM ${pgTable(p.table)}`, transaction)).map((r) => [r.id, r.password])
      );
      for (const row of rows) {
        row[pwSource] = await resolvePassword(row[pwSource], existing.get(String(row[pkSource])), bcrypt.compare);
      }
    }
  }

  const target = await transformRows(rows, p.map, {
    table: p.table,
    attributes,
    hash: (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS),
    stats,
  });
  return { rows, target };
};

const fillLiveTable = async (p, cols, target, transaction) => {
  await run(`DROP TABLE IF EXISTS ${LIVE}`, transaction);
  await run(`CREATE TEMP TABLE ${LIVE} AS SELECT ${cols.map(q).join(", ")} FROM ${pgTable(p.table)} WITH NO DATA`, transaction);
  for (let i = 0; i < target.length; i += BATCH) {
    const batch = target.slice(i, i + BATCH);
    const values = batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
    await sequelize.query(`INSERT INTO ${LIVE} (${cols.map(q).join(", ")}) VALUES ${values}`, {
      replacements: batch.flatMap((r) => cols.map((c) => r[c] ?? null)),
      transaction,
    });
  }
  for (const sql of LIVE_FIXUPS[p.table] || []) await run(sql, transaction);
};

const syncTable = async (p, transaction, result) => {
  const table = p.table;
  const pkAttr = p.model.primaryKeyAttributes[0];
  const pk = p.model.getAttributes()[pkAttr].field;
  const softDelete = Boolean(p.model.getAttributes().isDeleted);
  const T = pgTable(table);
  const stats = { defaulted: {}, passwordsHashed: 0 };

  if (!p.map.copy.some((c) => c.target === pk)) {
    result.skipped.push({ table, reason: `live has no ${pk} column` });
    return;
  }

  const { rows, target } = await loadLiveRows(p, pk, transaction, stats);
  // Live values the new database can't hold (a required field left empty …):
  // say which rows, so the office can fix them in the old system first.
  const problems = rowProblems(rows, p.map).filter((pr) => !pr.problem.includes("becomes empty"));
  if (problems.length) {
    const pkSource = p.map.copy.find((c) => c.target === pk).source;
    const detail = problems.map((pr) => {
      const c = p.map.copy.find((x) => x.target === pr.column);
      const bad = rows.filter((r) => {
        try {
          const v = coerceValue(r[c.source], c.attr);
          return pr.problem === "empty but required" ? v === null : String(v ?? "").slice(0, 40) === String(pr.sample ?? "");
        } catch (e) {
          return true;
        }
      });
      return `${table}.${pr.column}: ${pr.rows} row(s) ${pr.problem} (${pk} ${bad.slice(0, 10).map((r) => r[pkSource]).join(", ")}${bad.length > 10 ? " …" : ""})`;
    });
    throw new Refused(`Live has values the new database can't take. Fix them in the old system, then sync again:\n  ${detail.join("\n  ")}`);
  }
  // Columns to load: every column live has, plus new NOT NULL columns that
  // have a model default (is_deleted …). Others take the database default.
  const copied = p.map.copy.map((c) => c.target);
  const extra = p.map.targetOnly.filter((c) => target.length && target[0][c] !== undefined && target[0][c] !== null);
  const cols = [...copied, ...extra];
  const updatable = copied.filter((c) => c !== pk);

  await fillLiveTable(p, cols, target, transaction);
  const out = { table, live: target.length, inserted: [], updated: [], changedColumns: {}, skippedRemoved: 0, duplicatesRemoved: 0, onlyInNew: [], mirroredDeletes: 0, passwordsHashed: stats.passwordsHashed };

  out.skippedRemoved = (await run(skipRemovedSql(T, pk), transaction, { table })).length;

  // Rows not copied from live (above the highest id live had at the last
  // move/sync): typed into the new system, even if live has used the id since.
  if (NEW_ROW_TABLES.has(table)) {
    const [{ n: liveMax }] = await run(liveMaxSql(pk), transaction);
    out.liveMax = Number(liveMax);
    const recorded = result.syncState.get(table);
    const fresh = await run(newRowsSql(T, pk), transaction, { threshold: recorded ?? out.liveMax });
    if (fresh.length) result.newSystemRows.push({ table, ids: ids(fresh) });
  }

  const identity = IDENTITY_COLUMNS[table];
  if (identity) {
    const clashes = await run(identityClashSql(T, pk, identity), transaction);
    if (clashes.length) result.identityClashes.push({ table, rows: clashes });
  }

  // Live wins on changed rows.
  const [changed] = await run(changedCountSql(T, pk, updatable), transaction);
  out.changedColumns = Object.fromEntries(Object.entries(changed || {}).filter(([c, n]) => c !== "none" && n > 0));
  const upd = updateSql(T, pk, updatable);
  if (upd) {
    try {
      out.updated = ids(await run(upd, transaction));
    } catch (e) {
      throw new Error(`${table}: updating from live breaks a rule of the new database (${e.message}). Nothing was changed.`);
    }
  }

  // New rows, without duplicates.
  await run(`DROP TABLE IF EXISTS ${CAND}`, transaction);
  await run(candidatesSql(T, pk), transaction);
  for (const key of uniqueKeysFor(table)) {
    if (!REPLACEABLE_DUPLICATE_TABLES.has(table)) {
      const clashes = await run(clashSql(T, pk, key.columns), transaction);
      if (clashes.length) {
        throw new Refused(
          `${table}: new live row(s) clash with another on ${key.index} (${key.columns.join(", ")}): ` +
            `${JSON.stringify(clashes)}. Rename or remove the duplicate in the old system, then sync again.`
        );
      }
      continue;
    }
    for (const d of dedupeSqls(T, pk, key.columns)) {
      out.duplicatesRemoved += (await run(d.sql, transaction, { table })).length;
    }
  }
  out.inserted = ids(await run(insertSql(T, pk, cols, table), transaction));

  // Rows live no longer has.
  out.onlyInNew = ids(await run(onlyInTargetSql(T, pk, softDelete), transaction));
  if (MIRROR_DELETES && out.onlyInNew.length && NO_MIRROR_DELETE_TABLES.has(table)) {
    out.notMirrored = true; // listed in the summary; remove by hand if really wanted
  } else if (MIRROR_DELETES && out.onlyInNew.length) {
    const sql = softDelete
      ? `UPDATE ${T} SET ${q("is_deleted")} = TRUE WHERE ${q(pk)} IN (:ids)`
      : `DELETE FROM ${T} WHERE ${q(pk)} IN (:ids)`;
    await run(sql, transaction, { ids: out.onlyInNew });
    out.mirroredDeletes = out.onlyInNew.length;
  }

  await run(`DROP TABLE IF EXISTS ${CAND}`, transaction);
  await run(`DROP TABLE IF EXISTS ${LIVE}`, transaction);
  result.tables.push(out);

  const changes = out.inserted.length + out.updated.length + out.duplicatesRemoved + out.mirroredDeletes;
  log(
    `  ${table.padEnd(22)} live ${String(out.live).padStart(6)}  +${out.inserted.length} added  ~${out.updated.length} updated` +
      (out.duplicatesRemoved ? `  ${out.duplicatesRemoved} duplicate(s) removed` : "") +
      (out.skippedRemoved ? `  ${out.skippedRemoved} cleaned-up duplicate(s) kept out` : "") +
      (out.onlyInNew.length ? `  ${out.onlyInNew.length} not in live${out.mirroredDeletes ? " (removed)" : ""}` : "") +
      (changes ? "" : "  (no change)")
  );
};

// ---------------------------------------------------------------- after
const tableResult = (result, table) => result.tables.find((t) => t.table === table) || { inserted: [], updated: [], changedColumns: {} };

const afterRows = async (transaction, result) => {
  const derived = {};
  const fee = tableResult(result, "Fee");
  if (fee.inserted.length) await run(FEE_RECEIPT_YEAR_SQL, transaction, { ids: fee.inserted });
  const feeIds = [...fee.inserted, ...fee.updated];
  derived.paymentTermsSet = (await run(FEE_TERM_SQL, transaction, { ids: feeIds.length ? feeIds : [-1] })).length;

  derived.termsMarkedPromotedByOldSystem = (await run(TERM_PROMOTED_SQL, transaction)).length;
  for (const sql of TERM_YEAR_SQLS) await run(sql, transaction);

  const marks = tableResult(result, "Student_marks");
  const markIds = [...marks.inserted, ...marks.updated];
  if (markIds.length) await run(MARK_GRADE_SQLS[0], transaction, { ids: markIds });
  derived.marksGraded = (await run(MARK_GRADE_SQLS[1], transaction)).length;

  derived.pupilsRebased = (await run(REBASE_STUDENTS_SQL, transaction)).length;
  return derived;
};

// The app's own calculation, for every pupil, must give the live balance.
const verifyBalances = async (p, transaction) => {
  const [liveRows] = await p.my.query(`SELECT * FROM ${myQ(p.source)}`);
  const idCol = p.map.copy.find((c) => c.target === "student_id");
  const owingCol = p.map.copy.find((c) => c.target === "fees_owing");
  const live = new Map(liveRows.map((r) => [String(r[idCol.source]), Number(coerceValue(r[owingCol.source], owingCol.attr) ?? 0)]));
  const pupils = await run(`SELECT student_id::text AS id FROM "dbo"."Student" ORDER BY student_id`, transaction);
  const mismatches = [];
  for (const { id } of pupils) {
    if (!live.has(id)) continue; // only in the new database (see "not in live")
    const r = await recomputeStudentOwing(Number(id), { transaction });
    if (Math.abs(Number(r?.owing ?? 0) - live.get(id)) > 0.004) mismatches.push({ studentId: Number(id), live: live.get(id), new: r?.owing });
  }
  return { checked: pupils.length, mismatches };
};

// ---------------------------------------------------------------- report
const writeReport = (report) => {
  const dir = path.resolve(process.cwd(), "db/move-reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `sync-${DRY_RUN ? "dry-run-" : ""}${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
};

// nextval() is not undone by a rollback. Sequences a run may use without
// giving explicit ids: receipt numbers and new school years.
const SEQUENCES = [`"dbo".receipt_seq`, `pg_get_serial_sequence('"dbo"."Academic_year"', 'academic_year_id')`];
const saveSequences = async () => {
  const out = [];
  for (const expr of SEQUENCES) {
    const [[{ name }]] = await sequelize.query(`SELECT (${expr.startsWith("pg_") ? expr : `'${expr}'`})::text AS name`);
    if (!name) continue;
    const [[row]] = await sequelize.query(`SELECT last_value, is_called FROM ${name}`);
    out.push({ name, ...row });
  }
  return out;
};
const restoreSequences = async (saved) => {
  for (const s of saved) {
    await sequelize.query(`SELECT setval(:name, :v, :called)`, { replacements: { name: s.name, v: s.last_value, called: s.is_called } });
  }
};

// ---------------------------------------------------------------- main
const main = async () => {
  assertSafeTarget({ dryRun: false }); // a dry run writes too (then rolls back)
  await sequelize.authenticate();
  await assertTargetMigrated();
  await assertNewSystemUnused();

  const my = await connectSource();
  const report = { mode: DRY_RUN ? "dry-run" : "sync", mirrorDeletes: MIRROR_DELETES, startedAt: new Date().toISOString() };
  const result = { tables: [], skipped: [], identityClashes: [], newSystemRows: [], syncState: new Map() };
  const seqBefore = await saveSequences();
  let committed = false;

  try {
    log(`Source: MySQL ${my.config.database} -> Target: Postgres ${sequelize.getDatabaseName()}${DRY_RUN ? "  (DRY RUN: rolled back at the end)" : ""}`);
    const models = loadOrder(Object.values(sequelize.models));
    const { plan } = await analyse(my, models);
    const sourced = plan.filter((p) => p.source).map((p) => ({ ...p, my }));
    report.newOnlyTables = plan.filter((p) => !p.source).map((p) => p.table);
    const autoIncrement = await sourceAutoIncrement(my, sourced);

    let orphanCheck = [];
    try {
      await sequelize.transaction(async (transaction) => {
        // Keys off while loading (live has orphans from hard deletes), back on
        // NOT VALID, as the move does; validated after the commit.
        await run(`CREATE TABLE IF NOT EXISTS "dbo"."_removed_duplicates" (
          table_name TEXT NOT NULL, row_data JSONB NOT NULL, removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`, transaction);
        await run(SYNC_STATE_DDL, transaction);
        for (const r of await run(`SELECT table_name, live_max_id FROM "dbo"."_sync_state"`, transaction)) {
          result.syncState.set(r.table_name, Number(r.live_max_id));
        }
        const fks = await foreignKeys(transaction);
        for (const fk of fks) await run(`ALTER TABLE ${pgTable(fk.table)} DROP CONSTRAINT ${pgQ(fk.name)}`, transaction);

        log("\nRows:");
        for (const p of sourced) await syncTable(p, transaction, result);

        if (result.newSystemRows.length) {
          throw new Refused(
            "The new system has already been used (rows that were not copied from live), so live can't simply win:\n" +
              result.newSystemRows.map((r) => `  ${r.table}: ids ${r.ids.join(", ")}`).join("\n") +
              "\nThe sync is only for before go-live. After go-live the new system is the one to use."
          );
        }
        if (result.identityClashes.length) {
          throw new Refused(
            "Some rows have the same id in both databases but are a different record " +
              "(created in the new system, then live used the id). Live winning would overwrite them:\n" +
              result.identityClashes.map((c) => `  ${c.table}: ${JSON.stringify(c.rows.slice(0, 3))}`).join("\n")
          );
        }

        log("\nRecomputing what the migrations set from the data …");
        report.derived = await afterRows(transaction, result);
        log(`  ${JSON.stringify(report.derived)}`);

        const student = sourced.find((p) => p.table === "Student");
        if (student) {
          log("\nChecking every pupil's balance with the app's own calculation …");
          report.balances = await verifyBalances(student, transaction);
          if (report.balances.mismatches.length) {
            throw new Refused(
              `${report.balances.mismatches.length} pupil balance(s) would differ from live, so nothing was changed: ` +
                JSON.stringify(report.balances.mismatches.slice(0, 5))
            );
          }
          log(`  ✓ ${report.balances.checked} pupils: every balance equals live`);
        }
        // Keys back on only now: with them on, Postgres re-checks a row this
        // transaction already changed, and live has pupils in deleted classes.
        for (const fk of fks) await run(`ALTER TABLE ${pgTable(fk.table)} ADD CONSTRAINT ${pgQ(fk.name)} ${fk.def} NOT VALID`, transaction);
        if (!DRY_RUN) await resetSequences(sourced.map((p) => p.model), transaction, autoIncrement);
        // What live had, for the next sync's "typed into the new system" check.
        for (const t of result.tables.filter((x) => x.liveMax != null)) {
          await run(saveSyncStateSql, transaction, { table: t.table, maxId: t.liveMax });
        }
        orphanCheck = fks;
        if (DRY_RUN) throw new DryRunRollback();
      });
      committed = true;
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    } finally {
      // Rolled back (dry run or failure): give back the receipt numbers and
      // year ids it used, so receipts stay consecutive.
      if (!committed) await restoreSequences(seqBefore);
    }

    if (!DRY_RUN) {
      report.orphans = [];
      for (const fk of orphanCheck) {
        try {
          await sequelize.query(`ALTER TABLE ${pgTable(fk.table)} VALIDATE CONSTRAINT ${pgQ(fk.name)}`);
        } catch (e) {
          report.orphans.push(`${fk.table}.${fk.name}`);
        }
      }
    }

    report.tables = result.tables;
    report.skipped = result.skipped;
    report.finishedAt = new Date().toISOString();
    const file = writeReport(report);

    const total = (k) => result.tables.reduce((n, t) => n + (Array.isArray(t[k]) ? t[k].length : t[k] || 0), 0);
    log(`\n=== ${DRY_RUN ? "Dry run (nothing was saved)" : "Sync saved"} ===`);
    log(`+${total("inserted")} added, ~${total("updated")} updated, ${total("duplicatesRemoved")} duplicate(s) removed, ${total("passwordsHashed")} password(s) hashed`);
    for (const t of result.tables.filter((x) => Object.keys(x.changedColumns).length)) {
      log(`  ${t.table}: changed in live: ${Object.entries(t.changedColumns).map(([c, n]) => `${c} (${n})`).join(", ")}`);
    }
    const notInLive = result.tables.filter((t) => t.onlyInNew.length);
    if (notInLive.length) {
      log(`${MIRROR_DELETES ? "Removed (live deleted them)" : "Not in live any more (kept; --mirror-deletes removes them)"}:`);
      notInLive.forEach((t) =>
        log(`  ${t.table}: ${t.onlyInNew.length} (ids ${t.onlyInNew.slice(0, 10).join(", ")}${t.onlyInNew.length > 10 ? " …" : ""})` +
          (t.notMirrored ? "  KEPT: terms and payments are never removed automatically" : ""))
      );
    }
    if (report.orphans?.length) log(`! Foreign keys with orphan rows (kept, NOT VALID): ${report.orphans.join(", ")}`);
    if (result.skipped.length) log(`! Skipped: ${JSON.stringify(result.skipped)}`);
    log(`Report: ${file}`);
  } finally {
    await my.end();
    await sequelize.close();
  }
};

main().catch(async (err) => {
  console.error(`\n✗ Sync ${err instanceof Refused ? "refused" : "failed"}: ${err.message}`);
  console.error("Nothing was changed in the new database.");
  await sequelize.close().catch(() => {});
  process.exit(1);
});
