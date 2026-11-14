// Pure helpers for the MySQL -> Postgres data move (Phase 0.4.4).
// Kept free of DB connections so they can be unit-tested.

// Tables whose `password` column is a login secret. Live MySQL stores these in
// plaintext; the Postgres app only accepts bcrypt hashes (services/user.js).
const PASSWORD_TABLES = new Set(["Student", "Teacher", "User_account"]);

const isBcryptHash = (value) => typeof value === "string" && /^\$2[aby]\$/.test(value);

// The unique keys enforced by db/migrations/001_baseline_unique_indexes.sql.
// Used to report duplicates BEFORE the index is created.
const UNIQUE_KEYS = [
  { index: "uniq_marks", table: "Student_marks", columns: ["student_id", "subject_id", "class", "term_id"] },
  { index: "uniq_result", table: "Student_result", columns: ["student_id", "class", "term_id"] },
  { index: "uniq_kg", table: "KG_assessment", columns: ["student_id", "class", "term_id", "category", "assessment"] },
  { index: "uniq_attendance", table: "Attendance", columns: ["student_id", "date_marked", "term_id"] },
  { index: "uniq_total_attendance", table: "Total_attendance", columns: ["student_id", "term_id"] },
  { index: "uniq_subject_name", table: "Subject", columns: ["lower(name)"] },
];

const typeKey = (attr) => (attr.type?.key || attr.type?.constructor?.key || "").toUpperCase();

// Convert one MySQL value to what Postgres expects for the model attribute.
// mysql2 is opened with dateStrings + bigNumberStrings, so dates and big
// decimals arrive as strings and are passed through untouched (no TZ shifts).
const coerceValue = (value, attr) => {
  if (value === null || value === undefined) return null;
  const key = typeKey(attr);

  if (key === "BOOLEAN") {
    if (Buffer.isBuffer(value)) return value.length > 0 && value[0] === 1; // BIT(1)
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const s = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n", ""].includes(s)) return false;
    throw new Error(`Cannot convert ${JSON.stringify(value)} to boolean`);
  }

  if (key === "DATEONLY" || key === "DATE") {
    // MySQL zero dates are invalid in Postgres.
    if (typeof value === "string" && value.startsWith("0000-00-00")) return null;
    if (key === "DATEONLY" && typeof value === "string") return value.slice(0, 10);
    return value;
  }

  if (key === "JSON" || key === "JSONB") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  if (["INTEGER", "BIGINT", "SMALLINT", "DECIMAL", "FLOAT", "DOUBLE"].includes(key) && typeof value === "string") {
    // Live MySQL keeps some scores in text columns, with "---" or "" for "no
    // score". Those mean empty, so they become NULL (rowProblems reports them).
    if (/^\s*-*\s*$/.test(value)) return null;
  }

  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value;
};

// Match the model's columns to the source table's columns (case-insensitive).
// Returns what to copy, what is lost (source-only) and what falls back to its
// default (target-only).
const buildColumnMap = (attributes, sourceColumns) => {
  const sourceByLower = new Map(sourceColumns.map((c) => [c.toLowerCase(), c]));
  const copy = [];
  const targetOnly = [];
  const usedSource = new Set();

  for (const attr of Object.values(attributes)) {
    const field = attr.field || attr.fieldName;
    const src = sourceByLower.get(field.toLowerCase());
    if (src) {
      copy.push({ source: src, target: field, attr });
      usedSource.add(src);
    } else {
      targetOnly.push(field);
    }
  }
  const sourceOnly = sourceColumns.filter((c) => !usedSource.has(c));
  return { copy, sourceOnly, targetOnly };
};

// Columns where the source can hold decimals but the target keeps whole
// numbers (INTEGER, or DECIMAL with scale 0): Postgres would round silently
// (67.5 -> 68, GHc 350.50 -> 351). `sourceTypes` = { column: "decimal(18,2)" }.
// Returns [{ source, target, sourceType, targetType }] to check for fractions.
const roundingRisks = (map, sourceTypes) =>
  map.copy
    .map(({ source, target, attr }) => {
      const sourceType = String(sourceTypes[source] || "").toLowerCase();
      const m = sourceType.match(/^(decimal|numeric)\((\d+),\s*(\d+)\)/);
      const sourceHasFraction = /^(float|double|real)/.test(sourceType) || (m && Number(m[3]) > 0);
      const key = typeKey(attr);
      const scale = attr.type?.options?.scale ?? attr.type?._scale;
      const targetWhole = ["INTEGER", "BIGINT", "SMALLINT"].includes(key) || (key === "DECIMAL" && Number(scale ?? 0) === 0);
      return sourceHasFraction && targetWhole ? { source, target, sourceType, targetType: key + (key === "DECIMAL" ? `(${attr.type?.options?.precision ?? ""},${scale ?? 0})` : "") } : null;
    })
    .filter(Boolean);

// Dry-run check: would any source value make the real move abort? Postgres
// refuses NULL in NOT NULL columns (after the defaults the move applies),
// strings longer than the column, and impossible dates; coerceValue throws on
// unknown booleans. Returns [{ column, problem, rows, sample }].
const validDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const rowProblems = (rows, map) => {
  const found = new Map();
  const note = (column, problem, value) => {
    const key = `${column}|${problem}`;
    const f = found.get(key) || { column, problem, rows: 0, sample: value };
    f.rows += 1;
    found.set(key, f);
  };
  for (const row of rows) {
    for (const { source, target, attr } of map.copy) {
      let value;
      try {
        value = coerceValue(row[source], attr);
      } catch (e) {
        note(target, "cannot convert", String(row[source]).slice(0, 40));
        continue;
      }
      const key = typeKey(attr);
      const raw = row[source];
      if (value === null && typeof raw === "string" && raw.trim() !== "" && /^\s*-+\s*$/.test(raw)) {
        note(target, `"${raw.trim()}" (no score) becomes empty`, raw.trim());
      }
      if (value === null) {
        if (attr.allowNull === false && !attr.autoIncrement && defaultFor(attr) === null) note(target, "empty but required", null);
        continue;
      }
      const len = attr.type?._length ?? attr.type?.options?.length;
      if ((key === "STRING" || key === "CHAR") && len && String(value).length > len) {
        note(target, `longer than ${len} characters`, String(value).slice(0, 40));
      }
      if (["INTEGER", "BIGINT", "SMALLINT"].includes(key) && !/^\s*-?\d+\s*$/.test(String(value))) {
        note(target, "not a whole number", String(value).slice(0, 40));
      }
      if (key === "DECIMAL" && !/^\s*-?\d+(\.\d+)?\s*$/.test(String(value))) {
        note(target, "not a number", String(value).slice(0, 40));
      }
      if ((key === "DATEONLY" || key === "DATE") && typeof value === "string" && !validDate(value)) {
        note(target, "not a real date", value);
      }
    }
  }
  return [...found.values()];
};

// Default for a target-only column that is NOT NULL (e.g. the new is_deleted
// soft-delete flags, which did not exist in live MySQL).
const defaultFor = (attr) => {
  if (attr.defaultValue !== undefined && typeof attr.defaultValue !== "object") {
    return attr.defaultValue;
  }
  return null;
};

// Build target rows from source rows. `hash` (async) is applied to plaintext
// passwords in the PASSWORD_TABLES. Optional `stats` ({ defaulted: {},
// passwordsHashed: 0 }) collects what was changed, for the report.
const transformRows = async (rows, map, { table, attributes, hash, stats }) => {
  const needDefaults = Object.values(attributes).filter(
    (a) => map.targetOnly.includes(a.field) && a.allowNull === false && !a.autoIncrement
  );

  const out = [];
  for (const row of rows) {
    const target = {};
    for (const { source, target: field, attr } of map.copy) {
      let value = coerceValue(row[source], attr);
      // Live data has NULLs in columns that are now NOT NULL (e.g. Term.active).
      if (value === null && attr.allowNull === false && !attr.autoIncrement) {
        const fallback = defaultFor(attr);
        if (fallback !== null) {
          value = fallback;
          if (stats) stats.defaulted[field] = (stats.defaulted[field] || 0) + 1;
        }
      }
      target[field] = value;
    }
    for (const attr of needDefaults) {
      target[attr.field] = defaultFor(attr);
    }
    if (
      PASSWORD_TABLES.has(table) &&
      typeof target.password === "string" &&
      target.password !== "" &&
      !isBcryptHash(target.password)
    ) {
      target.password = await hash(target.password);
      if (stats) stats.passwordsHashed += 1;
    }
    out.push(target);
  }
  return out;
};

// Order tables so parents load before children (best effort; cycles such as
// Class <-> Teacher are fine because foreign keys are dropped during the load).
const loadOrder = (models) => {
  const names = models.map((m) => m.name);
  const deps = new Map(
    models.map((m) => [
      m.name,
      new Set(
        Object.values(m.associations || {})
          .filter((a) => a.associationType === "BelongsTo" && a.target.name !== m.name)
          .map((a) => a.target.name)
      ),
    ])
  );
  const ordered = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (done.has(n) || visiting.has(n)) return;
    visiting.add(n);
    for (const d of deps.get(n) || []) if (names.includes(d)) visit(d);
    visiting.delete(n);
    done.add(n);
    ordered.push(n);
  };
  names.forEach(visit);
  return ordered.map((n) => models.find((m) => m.name === n));
};

// SQL listing duplicate groups for one unique key ("q" quotes identifiers for
// the dialect: `x` for MySQL, "x" for Postgres).
const duplicateSql = (key, q, tableRef) => {
  const cols = key.columns.map((c) => (c.includes("(") ? c : q(c)));
  // A Postgres unique index treats NULLs as different, so groups with an empty
  // key column never block it (live data: 6,423 marks with no term_id).
  const notNull = cols.map((c) => `${c} IS NOT NULL`).join(" AND ");
  return (
    `SELECT ${cols.map((c, i) => `${c} AS k${i}`).join(", ")}, COUNT(*) AS n ` +
    `FROM ${tableRef} WHERE ${notNull} GROUP BY ${cols.join(", ")} HAVING COUNT(*) > 1 ` +
    `ORDER BY n DESC LIMIT 50`
  );
};

// The live MySQL was created by the old app with schema "dbo", which MySQL has
// no notion of, so Sequelize named its tables "dbo.Class", "dbo.Student", …
// (a dot inside the table name). Tables that had no schema (StudentFee) are
// plain. Prefer the "dbo." table, the one the old app used; fall back to the
// plain name (rehearsal fixtures, dumps loaded into a database called dbo).
const findSourceTable = (tables, name) => {
  const byName = (n) => tables.find((t) => t.toLowerCase() === n.toLowerCase());
  return byName(`dbo.${name}`) || byName(name);
};

export {
  PASSWORD_TABLES,
  findSourceTable,
  UNIQUE_KEYS,
  isBcryptHash,
  coerceValue,
  buildColumnMap,
  roundingRisks,
  rowProblems,
  transformRows,
  loadOrder,
  duplicateSql,
};
