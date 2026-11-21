// Shared by the MySQL -> Postgres data move (moveFromMysql.js) and the top-up
// sync (syncFromMysql.js): source connection, table/column mapping, foreign
// keys, id sequences and the non-local target guard.
import mysql from "mysql2/promise";
import sequelize from "../../config/database.js";
import { buildColumnMap, findSourceTable } from "../../utils/dataMove.js";

export const SCHEMA = "dbo";
const log = (...a) => console.log(...a);

export const pgTable = (name) => `"${SCHEMA}"."${name}"`;
export const pgQ = (c) => `"${c}"`;
export const myQ = (c) => `\`${c}\``;

export const connectSource = async () => {
  const uri = process.env.SOURCE_MYSQL_URL;
  if (!uri) throw new Error("Set SOURCE_MYSQL_URL=mysql://user:pass@host:port/database");
  return mysql.createConnection({
    uri,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
  });
};

export const sourceTables = async (my) => {
  const [rows] = await my.query("SHOW TABLES");
  return rows.map((r) => Object.values(r)[0]);
};

export const sourceColumns = async (my, table) => {
  const [rows] = await my.query(`SHOW COLUMNS FROM ${myQ(table)}`);
  return rows.map((r) => r.Field);
};

// ---------------------------------------------------------------- analysis
export const analyse = async (my, models) => {
  const tables = await sourceTables(my);
  const plan = [];
  for (const model of models) {
    const src = findSourceTable(tables, model.tableName);
    const plain = tables.find((t) => t.toLowerCase() === model.tableName.toLowerCase());
    if (src && plain && plain !== src) {
      log(`! Both ${src} and ${plain} exist in the source; copying ${src} (the table the old app used).`);
    }
    if (!src) {
      plan.push({ model, table: model.tableName, source: null });
      continue;
    }
    const cols = await sourceColumns(my, src);
    const map = buildColumnMap(model.getAttributes(), cols);
    const [[{ n }]] = await my.query(`SELECT COUNT(*) AS n FROM ${myQ(src)}`);
    plan.push({ model, table: model.tableName, source: src, map, sourceRows: Number(n) });
  }
  const mapped = new Set(plan.filter((p) => p.source).map((p) => p.source));
  const unmappedSourceTables = tables.filter((t) => !mapped.has(t));
  return { plan, unmappedSourceTables };
};

export const foreignKeys = async (transaction) => {
  const [rows] = await sequelize.query(
    `SELECT c.conname AS name, t.relname AS table, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND n.nspname = :schema`,
    { replacements: { schema: SCHEMA }, transaction }
  );
  return rows;
};

// MySQL never reuses an AUTO_INCREMENT id, and the live app hard-deleted
// pupils/classes/subjects/teachers while leaving their payments, marks and
// attendance behind (kept as orphans). Starting the sequence at MAX(id)+1
// would hand a deleted pupil's id - and their old rows - to the next new
// pupil. So start above the highest of: ids in the table, MySQL's
// AUTO_INCREMENT, and any column elsewhere with the same name (orphans).
export const sourceAutoIncrement = async (my, plan) => {
  const out = {};
  await my.query("SET SESSION information_schema_stats_expiry = 0").catch(() => {}); // MySQL 8; 5.7 has no cache
  for (const p of plan.filter((x) => x.source)) {
    const [[row]] = await my.query(
      "SELECT AUTO_INCREMENT AS ai FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [p.source]
    );
    if (row?.ai) out[p.table] = Number(row.ai) - 1;
  }
  return out;
};

export const resetSequences = async (models, transaction, autoIncrement = {}) => {
  for (const model of models) {
    for (const attr of Object.values(model.getAttributes())) {
      if (!attr.autoIncrement) continue;
      const col = attr.field;
      const [[{ seq }]] = await sequelize.query(
        "SELECT pg_get_serial_sequence(:t, :c) AS seq",
        { replacements: { t: pgTable(model.tableName), c: col }, transaction }
      );
      if (!seq) continue;
      const [refs] = await sequelize.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema = :s AND column_name = :c AND table_name <> :t",
        { replacements: { s: SCHEMA, c: col, t: model.tableName }, transaction }
      );
      const maxes = [`COALESCE((SELECT MAX(${pgQ(col)}) FROM ${pgTable(model.tableName)}), 0)`]
        .concat(refs.map((r) => `COALESCE((SELECT MAX(${pgQ(col)}) FROM ${pgTable(r.table_name)}), 0)`))
        .concat([String(Number(autoIncrement[model.tableName]) || 0)]);
      await sequelize.query(`SELECT setval(:seq, GREATEST(${maxes.join(", ")}) + 1, false)`, {
        replacements: { seq },
        transaction,
      });
    }
  }
};

// Safety: the move and the sync WRITE ROWS in the target. The local
// .env may point at a live server, so a non-local target must be named
// explicitly: --target=<DB_NAME>. Dry runs only read the source.
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db"]);
export const assertSafeTarget = ({ dryRun = false } = {}) => {
  if (dryRun) return;
  const host = String(process.env.DB_HOST || "").replace(/["']/g, "").trim();
  const name = String(process.env.DB_NAME || "").replace(/["']/g, "").trim();
  const confirmed = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1];
  if (!LOCAL_HOSTS.has(host) && confirmed !== name) {
    throw new Error(
      `Refusing to write to non-local database ${name} on ${host}. ` +
        `If this really is the new Postgres, re-run with --target=${name}`
    );
  }
};

