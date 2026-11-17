// AI-1: the read-only tools "Ask the school" may call. Ported from SchoolPro's
// ai/tools/catalogue/*.tools.ts, reduced to PP's tables.
//
// Rules (tested in aiAskTools.test.js / aiAskReadOnly.test.js):
//   - READ ONLY. Every tool is a plain SELECT ("dbo"."Table") or wraps an
//     existing read service. No create / update / destroy anywhere here.
//   - Aggregates or a short top-N list only, never a dump of a table. Lists
//     are capped (LIMIT) and carry the full count, so the model can say
//     "showing 20 of 73".
//   - No contact data: names, classes and figures only. run.js / chat.js
//     pass every result through redactForAi and cut it to 12,000 characters.
//   - No text-to-SQL: the model picks a tool and fills typed arguments; the
//     SQL is fixed and the arguments are bound as replacements.
//   - B10: each tool names the permissions it needs (`needs`: every group,
//     any key in a group), on top of ai.ask. They are the permissions of the
//     screen the same figures are on, so Ask never shows a role more than its
//     pages do:
//       current_term                  ai.ask alone (needed to name any term)
//       students_count(_by_class)     fees.view, accounting.view or academics.all_classes
//       fees_*                        fees.view
//       income_expense_summary        accounting.view
//       attendance_*                  attendance.view + academics.all_classes (whole school)
//       results_*                     results.view + academics.all_classes (whole school)
//       staff_list, staff_count       staff.view
//       staff_attendance_summary      staff_attendance.view
//     So the Administrator gets all of them and the Accountant (bursar) the
//     finance ones only: fees, income and expense, pupil counts and the
//     current term (client answer 6), as before B10. toolsFor(user) filters
//     what the model is OFFERED and invokeTool() refuses at CALL time as well,
//     so a tool name the model invents or remembers from an earlier turn
//     still can't run for the wrong role.
import sequelize from "../../../config/database.js";
import { AppError } from "../../../utils/errorHandling.js";
import { round2, toNum } from "../../../utils/money.js";
import { termName } from "../../academicYear.js";
import { getTermReport } from "../../academicReports.js";
import { getDashboardSummary } from "../../dashboard.js";
import { getProfitLoss } from "../../graph.js";
import { getStaffSummary } from "../../staffAttendance.js";
import { hasAnyPermission, hasPermission, P } from "../../../utils/permissions.js";

// What a tool needs besides ai.ask: a list of groups, each passed by ANY of its keys.
const NEEDS = Object.freeze({
  NOTHING_MORE: [],
  COUNTS: [["fees.view", "accounting.view", P.ALL_CLASSES]],
  FEES: [["fees.view"]],
  ACCOUNTING: [["accounting.view"]],
  ATTENDANCE: [["attendance.view"], [P.ALL_CLASSES]],
  RESULTS: [["results.view"], [P.ALL_CLASSES]],
  STAFF: [["staff.view"]],
  STAFF_ATTENDANCE: [["staff_attendance.view"]],
});

// The tool's error text reaches the model, which says it to the asker.
export class ToolInputError extends Error {}
export class ToolRefusedError extends Error {}

const select = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

const KEY = (col) => `LOWER(REGEXP_REPLACE(TRIM(${col}), '\\s+', ' ', 'g'))`;
const classKey = (name) => String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const dateOnly = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const pupilName = (r) => [r.fName, r.lName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || `Pupil ${r.studentId}`;

/** An optional whole-number argument, clamped to [min, max]. */
export const intArg = (args, key, { min = 1, max = 1_000_000, fallback = null } = {}) => {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ToolInputError(`${key} must be a whole number.`);
  return Math.min(max, Math.max(min, n));
};

const numArg = (args, key, { min = 0, max = 10_000_000, fallback = null } = {}) => {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ToolInputError(`${key} must be a number.`);
  return Math.min(max, Math.max(min, n));
};

// ---------------------------------------------------------------- terms and classes

const TERMS_SQL = `
SELECT t.term_id AS "termId", t.term, t.start_date AS "startDate", t.end_date AS "endDate", t.active,
  t.academic_year_id AS "academicYearId", y.name AS "yearName"
FROM "dbo"."Term" t
LEFT JOIN "dbo"."Academic_year" y ON y.academic_year_id = t.academic_year_id
ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC
LIMIT :limit`;

const ONE_TERM_SQL = `
SELECT t.term_id AS "termId", t.term, t.start_date AS "startDate", t.end_date AS "endDate", t.active,
  t.academic_year_id AS "academicYearId", y.name AS "yearName"
FROM "dbo"."Term" t
LEFT JOIN "dbo"."Academic_year" y ON y.academic_year_id = t.academic_year_id
WHERE (CAST(:termId AS integer) IS NULL AND t.active = TRUE) OR t.term_id = CAST(:termId AS integer)
ORDER BY t.term_id DESC
LIMIT 1`;

const termView = (t) =>
  t
    ? {
        termId: Number(t.termId),
        name: `${termName(t)}${t.yearName ? ` ${String(t.yearName).trim()}` : ""}`,
        startDate: dateOnly(t.startDate),
        endDate: dateOnly(t.endDate),
        current: Boolean(t.active),
      }
    : null;

/**
 * The term a tool reports on: the one asked for, else the open term, else the
 * most recent one (with a note, so the answer says which term it used).
 */
export const resolveTerm = async (args) => {
  const termId = intArg(args, "termId");
  const [row] = await select(ONE_TERM_SQL, { termId });
  if (row) return { term: row, note: null };
  if (termId) throw new ToolInputError(`There is no term with id ${termId}. Call current_term for the list of terms.`);
  const [latest] = await select(TERMS_SQL, { limit: 1 });
  if (!latest) throw new ToolInputError("No terms have been set up yet.");
  return { term: latest, note: `No term is open, so this is the most recent term (${termView(latest).name}).` };
};

const CLASS_SQL = `
SELECT class_id AS "classId", TRIM(name) AS "name", is_alumni AS "isAlumni"
FROM "dbo"."Class" WHERE class_id = :classId`;

/** The class asked for (by id), or null when none was asked for. */
const resolveClass = async (args) => {
  const classId = intArg(args, "classId");
  if (!classId) return null;
  const [row] = await select(CLASS_SQL, { classId });
  if (!row) throw new ToolInputError(`There is no class with id ${classId}. Call students_count_by_class for the class ids.`);
  return { classId: Number(row.classId), name: String(row.name).trim(), key: classKey(row.name) };
};

/** A.2's P/L range: the day after the previous term ended (the holiday before counts) to the term's end, or today. */
export const termRange = (term, terms = [], today = new Date().toISOString().slice(0, 10)) => {
  const start = dateOnly(term?.startDate);
  const end = dateOnly(term?.endDate);
  if (!start) return null;
  const prevEnd = terms
    .map((t) => dateOnly(t?.endDate))
    .filter((e) => e && e < start)
    .sort()
    .at(-1);
  let from = start;
  if (prevEnd) {
    const d = new Date(`${prevEnd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    from = d.toISOString().slice(0, 10);
  }
  if (start > today) return { from, to: end && end >= start ? end : start };
  return { from, to: end && end < today ? end : today };
};

// ---------------------------------------------------------------- terms parameters (shared)

const TERM_PARAM = {
  termId: {
    type: "integer",
    description: "The term's id from current_term. Leave out for the current term.",
  },
};
const CLASS_PARAM = {
  classId: {
    type: "integer",
    description: "The class's id from students_count_by_class. Leave out for the whole school.",
  },
};
const LIMIT_PARAM = (dflt, max) => ({
  limit: { type: "integer", description: `How many to list (default ${dflt}, at most ${max}).` },
});

// ---------------------------------------------------------------- the tools

const STUDENTS_BY_CLASS_SQL = `
SELECT c.class_id AS "classId", TRIM(c.name) AS "name", c.section, c.is_alumni AS "isAlumni",
  COUNT(s.student_id)::int AS "pupils",
  COUNT(s.student_id) FILTER (WHERE LOWER(TRIM(s.gender)) = 'male')::int AS "boys",
  COUNT(s.student_id) FILTER (WHERE LOWER(TRIM(s.gender)) = 'female')::int AS "girls"
FROM "dbo"."Class" c
LEFT JOIN "dbo"."Student" s ON s.class_id = c.class_id AND s.is_deleted IS NOT TRUE
WHERE c.is_deleted IS NOT TRUE
GROUP BY c.class_id, c.name, c.section, c.is_alumni
ORDER BY c.is_alumni, TRIM(c.name)`;

const UNPLACED_SQL = `
SELECT COUNT(*)::int AS "pupils" FROM "dbo"."Student" s
WHERE s.is_deleted IS NOT TRUE AND s.class_id IS NULL`;

const OWING_SQL = `
SELECT s.student_id AS "studentId", s.f_name AS "fName", s.l_name AS "lName", TRIM(c.name) AS "className",
  s.fees_owing::float AS "owing",
  COUNT(*) OVER ()::int AS "count", SUM(s.fees_owing) OVER ()::float AS "totalOwing"
FROM "dbo"."Student" s
LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
WHERE s.is_deleted IS NOT TRUE AND s.fees_owing > 0 AND s.fees_owing >= :minAmount
  AND (CAST(:classId AS integer) IS NULL OR s.class_id = CAST(:classId AS integer))
ORDER BY s.fees_owing DESC, s.student_id
LIMIT :limit`;

const COLLECTION_BY_TERM_SQL = `
SELECT t.term_id AS "termId", t.term, t.start_date AS "startDate", t.end_date AS "endDate", t.active, y.name AS "yearName",
  COALESCE(SUM(f.paid), 0)::float AS "collected", COUNT(f.fee_id)::int AS "payments",
  COUNT(DISTINCT f.student_id)::int AS "pupilsPaid"
FROM "dbo"."Term" t
LEFT JOIN "dbo"."Fee" f ON f.term_id = t.term_id AND f.reversed_at IS NULL
LEFT JOIN "dbo"."Academic_year" y ON y.academic_year_id = t.academic_year_id
WHERE CAST(:termId AS integer) IS NULL OR t.term_id = CAST(:termId AS integer)
GROUP BY t.term_id, t.term, t.start_date, t.end_date, t.active, y.name
ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC
LIMIT :limit`;

const NO_TERM_PAYMENTS_SQL = `
SELECT COALESCE(SUM(f.paid), 0)::float AS "collected", COUNT(*)::int AS "payments"
FROM "dbo"."Fee" f WHERE f.reversed_at IS NULL AND f.term_id IS NULL`;

const COLLECTION_BY_CLASS_SQL = `
SELECT f.class_id AS "classId", TRIM(c.name) AS "className",
  COALESCE(SUM(f.paid), 0)::float AS "collected", COUNT(*)::int AS "payments",
  COUNT(DISTINCT f.student_id)::int AS "pupilsPaid"
FROM "dbo"."Fee" f
LEFT JOIN "dbo"."Class" c ON c.class_id = f.class_id
WHERE f.reversed_at IS NULL AND f.term_id = :termId
GROUP BY f.class_id, c.name
ORDER BY "collected" DESC`;

const OWING_BY_CLASS_SQL = `
SELECT s.class_id AS "classId", COALESCE(SUM(s.fees_owing) FILTER (WHERE s.fees_owing > 0), 0)::float AS "owingNow",
  COUNT(*) FILTER (WHERE s.fees_owing > 0)::int AS "pupilsOwing"
FROM "dbo"."Student" s
WHERE s.is_deleted IS NOT TRUE
GROUP BY s.class_id`;

// Pupil by pupil for one term: the closed-term roll-up if there is one, else
// the daily register (as B11). Sick counts as not present.
const ABSENTEES_SQL = `
WITH tot AS (
  SELECT DISTINCT ON (student_id) student_id, COALESCE(present, 0)::int AS present, COALESCE(attendance, 0)::int AS days
  FROM "dbo"."Total_attendance"
  WHERE term_id = :termId AND student_id IS NOT NULL
  ORDER BY student_id, total_attendance_id DESC
),
live AS (
  SELECT student_id, SUM(CASE WHEN TRIM(status) = 'Present' THEN 1 ELSE 0 END)::int AS present, COUNT(status)::int AS days
  FROM "dbo"."Attendance"
  WHERE term_id = :termId AND student_id IS NOT NULL
  GROUP BY student_id
),
per AS (
  SELECT student_id, present, days FROM tot
  UNION ALL
  SELECT l.student_id, l.present, l.days FROM live l
  WHERE NOT EXISTS (SELECT 1 FROM tot t WHERE t.student_id = l.student_id)
)
SELECT p.student_id AS "studentId", s.f_name AS "fName", s.l_name AS "lName", TRIM(c.name) AS "className",
  p.present, p.days, ROUND(p.present * 100.0 / p.days, 1)::float AS "rate",
  COUNT(*) OVER ()::int AS "count"
FROM per p
JOIN "dbo"."Student" s ON s.student_id = p.student_id
LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
WHERE s.is_deleted IS NOT TRUE AND p.days >= :minDays AND p.present * 100.0 / p.days < :below
  AND (CAST(:classId AS integer) IS NULL OR s.class_id = CAST(:classId AS integer))
ORDER BY "rate", p.days DESC, p.student_id
LIMIT :limit`;

// A pupil's term score = raw / total raw × 100 (as B5, B7 and B11); the newest
// result row counts when old data has two.
const rankedSql = (direction) => `
WITH r AS (
  SELECT DISTINCT ON (student_id) student_id, TRIM(class) AS class_name,
    CASE WHEN total_raw_score > 0 THEN raw_score * 100.0 / total_raw_score END AS pct
  FROM "dbo"."Student_result"
  WHERE term_id = :termId AND student_id IS NOT NULL
    AND (CAST(:classKey AS text) IS NULL OR ${KEY("class")} = CAST(:classKey AS text))
  ORDER BY student_id, student_result_id DESC
)
SELECT r.student_id AS "studentId", s.f_name AS "fName", s.l_name AS "lName", r.class_name AS "className",
  ROUND(r.pct, 1)::float AS "score", COUNT(*) OVER ()::int AS "count"
FROM r
JOIN "dbo"."Student" s ON s.student_id = r.student_id
WHERE r.pct IS NOT NULL
ORDER BY r.pct ${direction}, r.student_id
LIMIT :limit`;
const TOP_SQL = rankedSql("DESC");
const BOTTOM_SQL = rankedSql("ASC");

const STAFF_LIST_SQL = `
SELECT t.teacher_id AS "teacherId", TRIM(CONCAT_WS(' ', TRIM(t.f_name), TRIM(t.l_name))) AS "name",
  NULLIF(TRIM(t.staff_position), '') AS "position", NULLIF(TRIM(t.gender), '') AS "gender",
  (SELECT STRING_AGG(TRIM(c.name), ', ' ORDER BY TRIM(c.name)) FROM "dbo"."Class" c
     WHERE c.teacher_id = t.teacher_id AND c.is_deleted IS NOT TRUE) AS "classTeacherOf",
  COUNT(*) OVER ()::int AS "count"
FROM "dbo"."Teacher" t
WHERE t.is_deleted IS NOT TRUE
ORDER BY TRIM(t.f_name), TRIM(t.l_name), t.teacher_id
LIMIT :limit`;

const STAFF_COUNT_SQL = `
SELECT COALESCE(NULLIF(TRIM(t.staff_position), ''), 'No position recorded') AS "position",
  COUNT(*)::int AS "staff",
  COUNT(*) FILTER (WHERE LOWER(TRIM(t.gender)) = 'male')::int AS "men",
  COUNT(*) FILTER (WHERE LOWER(TRIM(t.gender)) = 'female')::int AS "women"
FROM "dbo"."Teacher" t
WHERE t.is_deleted IS NOT TRUE
GROUP BY 1
ORDER BY "staff" DESC, 1`;

const listOf = (rows, shape) => ({
  total: rows.length ? Number(rows[0].count) : 0,
  shown: rows.length,
  rows: rows.map(shape),
});

export const TOOLS = [
  {
    name: "current_term",
    needs: NEEDS.NOTHING_MORE,
    description:
      "The term that is open now and the most recent terms with their ids and dates. Call this first whenever a question names a term ('last term', 'Term 2').",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const rows = await select(TERMS_SQL, { limit: 9 });
      const current = rows.find((t) => t.active) || null;
      return {
        currentTerm: termView(current),
        note: current ? null : "No term is open right now.",
        recentTerms: rows.map(termView),
      };
    },
  },
  {
    name: "students_count",
    needs: NEEDS.COUNTS,
    description:
      "How many pupils are on the roll now (not counting graduated or left classes), with boys and girls and the number of classes.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const s = await getDashboardSummary();
      return {
        pupilsOnRoll: s.activeStudents,
        boys: s.boys,
        girls: s.girls,
        includingGraduatedOrLeft: s.totalStudents,
        classes: s.totalClasses,
      };
    },
  },
  {
    name: "students_count_by_class",
    needs: NEEDS.COUNTS,
    description: "Pupils on the roll in each class (with boys and girls) and each class's id. Graduated / left classes are listed apart.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const rows = await select(STUDENTS_BY_CLASS_SQL);
      const [unplaced] = await select(UNPLACED_SQL);
      const shape = (r) => ({ classId: Number(r.classId), name: r.name, pupils: r.pupils, boys: r.boys, girls: r.girls });
      const classes = rows.filter((r) => !r.isAlumni).map(shape);
      return {
        totalOnRoll: classes.reduce((n, c) => n + c.pupils, 0) + (unplaced?.pupils || 0),
        classes,
        pupilsWithNoClass: unplaced?.pupils || 0,
        graduatedOrLeftClasses: rows.filter((r) => r.isAlumni).map(shape),
      };
    },
  },
  {
    name: "fees_students_owing",
    needs: NEEDS.FEES,
    description:
      "Pupils who owe fees now, most owed first, with the total owed and how many owe. Optional minimum amount (GH₵) and class.",
    parameters: {
      type: "object",
      properties: {
        minAmount: { type: "number", description: "Only pupils owing at least this many cedis (default 1)." },
        ...CLASS_PARAM,
        ...LIMIT_PARAM(20, 50),
      },
    },
    handler: async (args) => {
      const minAmount = numArg(args, "minAmount", { min: 0.01, fallback: 1 });
      const klass = await resolveClass(args);
      const rows = await select(OWING_SQL, { minAmount, classId: klass?.classId ?? null, limit: intArg(args, "limit", { max: 50, fallback: 20 }) });
      return {
        class: klass?.name ?? "whole school",
        minAmount,
        pupilsOwing: rows.length ? rows[0].count : 0,
        totalOwing: rows.length ? round2(toNum(rows[0].totalOwing)) : 0,
        shown: rows.length,
        pupils: rows.map((r) => ({ name: pupilName(r), class: r.className ?? "No class", owing: round2(toNum(r.owing)) })),
      };
    },
  },
  {
    name: "fees_collection_by_term",
    needs: NEEDS.FEES,
    description:
      "Fees collected (payments, reversed ones left out) per term, newest term first, with the number of payments and pupils who paid. Optional single term.",
    parameters: { type: "object", properties: { ...TERM_PARAM, ...LIMIT_PARAM(6, 12) } },
    handler: async (args) => {
      const termId = intArg(args, "termId");
      const rows = await select(COLLECTION_BY_TERM_SQL, { termId, limit: termId ? 1 : intArg(args, "limit", { max: 12, fallback: 6 }) });
      if (termId && !rows.length) throw new ToolInputError(`There is no term with id ${termId}.`);
      const [none] = termId ? [null] : await select(NO_TERM_PAYMENTS_SQL);
      return {
        terms: rows.map((r) => ({ ...termView(r), collected: round2(toNum(r.collected)), payments: r.payments, pupilsPaid: r.pupilsPaid })),
        ...(none && none.payments ? { paymentsWithNoTerm: { collected: round2(toNum(none.collected)), payments: none.payments } } : {}),
      };
    },
  },
  {
    name: "fees_collection_by_class",
    needs: NEEDS.FEES,
    description: "Fees collected in one term per class (by the class the payment was recorded for), plus what each class owes now.",
    parameters: { type: "object", properties: { ...TERM_PARAM } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const rows = await select(COLLECTION_BY_CLASS_SQL, { termId: Number(term.termId) });
      const owing = new Map((await select(OWING_BY_CLASS_SQL)).map((r) => [r.classId == null ? null : Number(r.classId), r]));
      return {
        term: termView(term),
        note,
        totalCollected: round2(rows.reduce((s, r) => s + toNum(r.collected), 0)),
        classes: rows.map((r) => {
          const o = owing.get(r.classId == null ? null : Number(r.classId));
          return {
            class: r.className ?? "No class recorded",
            collected: round2(toNum(r.collected)),
            payments: r.payments,
            pupilsPaid: r.pupilsPaid,
            owingNow: round2(toNum(o?.owingNow)),
            pupilsOwingNow: o?.pupilsOwing ?? 0,
          };
        }),
      };
    },
  },
  {
    name: "income_expense_summary",
    needs: NEEDS.ACCOUNTING,
    description:
      "Profit and loss for one term: fees collected, other income, expenses and the balance. The term runs from the day after the previous term ended (fees paid in the holiday count) to its end, or today.",
    parameters: { type: "object", properties: { ...TERM_PARAM } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const terms = await select(TERMS_SQL, { limit: 200 });
      const range = termRange(term, terms);
      if (!range) throw new ToolInputError("That term has no start date, so its money can't be added up.");
      const pl = await getProfitLoss({ startDate: range.from, endDate: range.to });
      return {
        term: termView(term),
        note,
        from: range.from,
        to: range.to,
        feesCollected: round2(toNum(pl.feesTotal)),
        otherIncome: round2(toNum(pl.incomeTotal)),
        expenses: round2(toNum(pl.expenseTotal)),
        balance: round2(toNum(pl.profit)),
      };
    },
  },
  {
    name: "attendance_rate_by_class",
    needs: NEEDS.ATTENDANCE,
    description: "Pupil attendance rate (days present ÷ days marked; sick counts as absent) per class and for the school, for one term.",
    parameters: { type: "object", properties: { ...TERM_PARAM } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const report = await getTermReport(term.termId);
      return {
        term: termView(term),
        note,
        schoolRate: report.totals?.attendanceRate ?? null,
        daysMarked: report.totals?.daysMarked ?? 0,
        classes: (report.classes || [])
          .filter((c) => c.daysMarked > 0)
          .map((c) => ({ classId: c.classId, class: c.name, rate: c.attendanceRate, daysMarked: c.daysMarked })),
      };
    },
  },
  {
    name: "attendance_chronic_absentees",
    needs: NEEDS.ATTENDANCE,
    description:
      "Pupils whose attendance in one term is below a rate (default 80%), lowest first, with days present and marked. Pupils with fewer than 5 days marked are left out.",
    parameters: {
      type: "object",
      properties: {
        ...TERM_PARAM,
        ...CLASS_PARAM,
        belowRate: { type: "number", description: "Attendance % to list below (default 80)." },
        ...LIMIT_PARAM(20, 50),
      },
    },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const klass = await resolveClass(args);
      const below = numArg(args, "belowRate", { min: 1, max: 100, fallback: 80 });
      const rows = await select(ABSENTEES_SQL, {
        termId: Number(term.termId),
        classId: klass?.classId ?? null,
        below,
        minDays: 5,
        limit: intArg(args, "limit", { max: 50, fallback: 20 }),
      });
      return {
        term: termView(term),
        note,
        class: klass?.name ?? "whole school",
        belowRate: below,
        ...listOf(rows, (r) => ({ name: pupilName(r), class: r.className ?? "No class", present: r.present, daysMarked: r.days, rate: r.rate })),
      };
    },
  },
  {
    name: "results_subject_averages",
    needs: NEEDS.RESULTS,
    description:
      "Average subject mark and pass rate per subject for one term, for the whole school or one class (needs that class's id).",
    parameters: { type: "object", properties: { ...TERM_PARAM, ...CLASS_PARAM } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const klass = await resolveClass(args);
      const report = await getTermReport(term.termId);
      if (klass) {
        const row = (report.classes || []).find((c) => c.classKey === klass.key || c.classId === klass.classId);
        return {
          term: termView(term),
          note,
          class: klass.name,
          averageScore: row?.averageScore ?? null,
          passRate: row?.passRate ?? null,
          subjects: (row?.subjects || []).map((s) => ({ subject: s.name, average: s.average, passRate: s.passRate, marks: s.marks })),
        };
      }
      return {
        term: termView(term),
        note,
        class: "whole school",
        averageScore: report.totals?.averageScore ?? null,
        passRate: report.totals?.passRate ?? null,
        subjects: (report.subjects || []).map((s) => ({ subject: s.name, average: s.average, passRate: s.passRate, marks: s.marks, classes: s.classes })),
      };
    },
  },
  ...[
    ["results_top_students", TOP_SQL, "highest"],
    ["results_bottom_students", BOTTOM_SQL, "lowest"],
  ].map(([name, sql, word]) => ({
    name,
    needs: NEEDS.RESULTS,
    description: `Pupils with the ${word} overall term score (% of the total marks) in one term, for the school or one class.`,
    parameters: { type: "object", properties: { ...TERM_PARAM, ...CLASS_PARAM, ...LIMIT_PARAM(10, 30) } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const klass = await resolveClass(args);
      const rows = await select(sql, { termId: Number(term.termId), classKey: klass?.key ?? null, limit: intArg(args, "limit", { max: 30, fallback: 10 }) });
      return {
        term: termView(term),
        note,
        class: klass?.name ?? "whole school",
        ...listOf(rows, (r) => ({ name: pupilName(r), class: r.className ?? "No class", score: r.score })),
      };
    },
  })),
  {
    name: "staff_list",
    needs: NEEDS.STAFF,
    description: "Staff on the books now: name, position and the class they are class teacher of. No contact details.",
    parameters: { type: "object", properties: { ...LIMIT_PARAM(60, 100) } },
    handler: async (args) => {
      const rows = await select(STAFF_LIST_SQL, { limit: intArg(args, "limit", { max: 100, fallback: 60 }) });
      return listOf(rows, (r) => ({ name: r.name, position: r.position ?? "Not recorded", classTeacherOf: r.classTeacherOf ?? null }));
    },
  },
  {
    name: "staff_count",
    needs: NEEDS.STAFF,
    description: "How many staff are on the books now, by position, with men and women.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const rows = await select(STAFF_COUNT_SQL);
      return {
        totalStaff: rows.reduce((n, r) => n + r.staff, 0),
        byPosition: rows.map((r) => ({ position: r.position, staff: r.staff, men: r.men, women: r.women })),
      };
    },
  },
  {
    name: "staff_attendance_summary",
    needs: NEEDS.STAFF_ATTENDANCE,
    description: "Staff attendance for one term: days marked, present, late, absent, sick, on leave and the % attended (present + late), for the school and each member of staff.",
    parameters: { type: "object", properties: { ...TERM_PARAM } },
    handler: async (args) => {
      const { term, note } = await resolveTerm(args);
      const s = await getStaffSummary({ termId: term.termId });
      const row = (x) => ({
        marked: x.marked,
        present: x.counts?.PRESENT ?? 0,
        late: x.counts?.LATE ?? 0,
        absent: x.counts?.ABSENT ?? 0,
        sick: x.counts?.SICK ?? 0,
        onLeave: x.counts?.ON_LEAVE ?? 0,
        permission: x.counts?.PERMISSION ?? 0,
        percent: x.percent,
      });
      return {
        term: termView(term),
        note,
        school: { staff: s.totals?.staff ?? 0, ...row(s.totals || {}) },
        staff: (s.staff || []).filter((x) => x.marked > 0).slice(0, 80).map((x) => ({ name: x.name, ...row(x) })),
      };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * May this caller run the tool? An office login whose role holds ai.ask and
 * every group of the tool's `needs` (portal tokens never get tools: they carry
 * no permissions).
 */
export const toolAllowed = (tool, user) =>
  Boolean(tool && user?.category && hasPermission(user, P.AI_ASK) && tool.needs.every((group) => hasAnyPermission(user, group)));

/** The tools to OFFER the model for this caller. */
export const toolsFor = (user) => TOOLS.filter((t) => toolAllowed(t, user));

/**
 * Run one tool for a caller, checking the permissions AGAIN at call time. Throws
 * ToolRefusedError for a tool the role may not use (or one that doesn't exist)
 * and ToolInputError for bad arguments; any other failure is logged and given
 * to the model as a plain "couldn't look that up".
 */
export const invokeTool = async (name, args, { user } = {}) => {
  const tool = BY_NAME.get(name);
  if (!tool) throw new ToolRefusedError(`There is no tool called ${name}.`);
  if (!toolAllowed(tool, user)) throw new ToolRefusedError("This is not something you can look up for this user.");
  try {
    return await tool.handler(args && typeof args === "object" && !Array.isArray(args) ? args : {}, { user });
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof ToolRefusedError) throw error;
    if (error instanceof AppError && error.statusCode < 500) throw new ToolInputError(error.message);
    console.error(`AI-1 tool ${name} failed:`, error?.message || error);
    throw new Error("That couldn't be looked up just now.");
  }
};

/** Declarations as the model sees them (no permissions, no handlers). */
export const declarationsFor = (user) => toolsFor(user).map(({ name, description, parameters }) => ({ name, description, parameters }));
