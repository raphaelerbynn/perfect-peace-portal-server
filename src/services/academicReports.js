import sequelize from "../config/database.js";
import { AcademicYear, Class, Student, Subject, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { assertClassAccess } from "./attendance.js";
import { termName } from "./academicYear.js";
import { DEFAULT_PRIMARY_BANDS, listScales, pickScale } from "./grading.js";
import { getRules, resolvePassMark } from "./promotion.js";
import { competitionRank } from "./reportCards.js";
import { isKgSection } from "./teacherScope.js";
import { getClassAttendanceSummary } from "./yearReports.js";

// ---------------------------------------------------------------------------
// B11: academic reports. Read only; no tables of its own.
//
// Ported from SchoolPro reports.service.ts (terms-overview + term detail),
// with PP's rules:
//  - Score = a pupil's term result: raw score / total raw score × 100 (as
//    promotion, B5, and the whole-year results, B7). KG classes have no
//    scores: they count in pupils and attendance only.
//  - Pass = that score at or above the class's promotion pass mark (B5:
//    class rule, else the school's, else 40). A subject mark passes at the
//    subject's own pass mark when it has one, else the class pass mark.
//  - Attendance rate = days present ÷ days marked. Sick counts as not present
//    (as the B7 summary and report cards show it). Closed terms use the
//    roll-up (Total_attendance), the open term its daily register.
//  - No data = null, never 0 (a gap on the chart, "—" in the table).
//  - Old data can hold two result rows for a pupil, term and class: the
//    newest counts (as B7). Class names are matched trimmed, ignoring case
//    (live has " NURSERY 2").
//  - Soft-deleted pupils still count for the terms they sat (history).
// Aggregates are SQL (Postgres); the shaping below is pure and tested.
// ---------------------------------------------------------------------------

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};
const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const round1 = (n) => Math.round(n * 10) / 10;
/** a ÷ b as a 1-dp percentage, or null when there is nothing to divide by. */
export const rate = (part, whole) => (num(whole) > 0 ? round1((num(part) / num(whole)) * 100) : null);
const mean = (sum, count) => (num(count) > 0 ? round1(num(sum) / num(count)) : null);
export const classKey = (name) => String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const UNKNOWN_CLASS = "Class not recorded";

const termSort = (a, b) =>
  String(a.startDate || "9999").localeCompare(String(b.startDate || "9999")) || Number(a.termId) - Number(b.termId);

// --- SQL ---------------------------------------------------------------------

const ONE_TERM = (col = "term_id") => `(CAST(:termId AS integer) IS NULL OR ${col} = CAST(:termId AS integer))`;
const KEY = (col = "class") => `LOWER(REGEXP_REPLACE(TRIM(${col}), '\\s+', ' ', 'g'))`;
const select = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

/** Pass marks per class key, as a JSON list for the SQL (the school default goes separately). */
const PASS_MARKS = `pm AS (SELECT k, m FROM jsonb_to_recordset(CAST(:marks AS jsonb)) AS x(k text, m numeric))`;

/** Per term and class: pupils with a result, how many have a score, the sum of scores, how many passed. */
const RESULTS_SQL = `
WITH ${PASS_MARKS},
r AS (
  SELECT DISTINCT ON (student_id, term_id, ${KEY()})
    student_id, term_id, ${KEY()} AS class_key, TRIM(class) AS class_name,
    CASE WHEN total_raw_score > 0 THEN raw_score * 100.0 / total_raw_score END AS pct
  FROM "dbo"."Student_result"
  WHERE term_id IS NOT NULL AND ${ONE_TERM()}
  ORDER BY student_id, term_id, ${KEY()}, student_result_id DESC
)
SELECT r.term_id AS "termId", r.class_key AS "classKey", MIN(r.class_name) AS "className",
  COUNT(*)::int AS "pupils", COUNT(r.pct)::int AS "scored", COALESCE(SUM(r.pct), 0)::float AS "sumPct",
  COUNT(*) FILTER (WHERE ROUND(r.pct, 1) >= COALESCE(pm.m, CAST(:defaultMark AS numeric)))::int AS "passed"
FROM r LEFT JOIN pm ON pm.k = r.class_key
GROUP BY r.term_id, r.class_key`;

/**
 * Per term and class: days present and days marked. Each pupil-term counts
 * once: the closed-term roll-up if there is one, else the daily register.
 * A rolled-up pupil's class is the class their results were filed under.
 */
const ATTENDANCE_SQL = `
WITH tot AS (
  SELECT DISTINCT ON (student_id, term_id) student_id, term_id, present, attendance AS days
  FROM "dbo"."Total_attendance"
  WHERE term_id IS NOT NULL AND ${ONE_TERM()}
  ORDER BY student_id, term_id, total_attendance_id DESC
),
live AS (
  SELECT student_id, term_id, ${KEY()} AS class_key,
    SUM(CASE WHEN TRIM(status) = 'Present' THEN 1 ELSE 0 END) AS present, COUNT(status) AS days
  FROM "dbo"."Attendance"
  WHERE term_id IS NOT NULL AND ${ONE_TERM()}
  GROUP BY student_id, term_id, ${KEY()}
),
cls AS (
  SELECT student_id, term_id, MIN(class_key) AS class_key FROM (
    SELECT student_id, term_id, ${KEY()} AS class_key FROM "dbo"."Student_result" WHERE ${ONE_TERM()}
    UNION ALL
    SELECT student_id, term_id, ${KEY()} AS class_key FROM "dbo"."KG_assessment" WHERE ${ONE_TERM()}
  ) u GROUP BY student_id, term_id
),
per AS (
  SELECT t.term_id, c.class_key, t.present, t.days FROM tot t LEFT JOIN cls c USING (student_id, term_id)
  UNION ALL
  SELECT l.term_id, l.class_key, l.present, l.days FROM live l
  WHERE NOT EXISTS (SELECT 1 FROM tot t WHERE t.student_id = l.student_id AND t.term_id = l.term_id)
)
SELECT term_id AS "termId", class_key AS "classKey",
  COALESCE(SUM(present), 0)::int AS "present", COALESCE(SUM(days), 0)::int AS "days"
FROM per GROUP BY term_id, class_key`;

/** Per term: distinct pupils with any result, KG assessment or attendance. */
const PUPILS_SQL = `
SELECT term_id AS "termId", COUNT(DISTINCT student_id)::int AS "pupils" FROM (
  SELECT student_id, term_id FROM "dbo"."Student_result"
  UNION ALL SELECT student_id, term_id FROM "dbo"."KG_assessment"
  UNION ALL SELECT student_id, term_id FROM "dbo"."Attendance"
  UNION ALL SELECT student_id, term_id FROM "dbo"."Total_attendance"
) u
WHERE term_id IS NOT NULL AND ${ONE_TERM()}
GROUP BY term_id`;

/** One term, per class: who should have results (as the B4 report-card check). */
const ROSTER_SQL = `
WITH d AS (
  SELECT student_id, ${KEY()} AS class_key, 'r' AS src FROM "dbo"."Student_result" WHERE term_id = :termId
  UNION ALL SELECT student_id, ${KEY()}, 'r' FROM "dbo"."Student_marks" WHERE term_id = :termId
  UNION ALL SELECT student_id, ${KEY()}, 'k' FROM "dbo"."KG_assessment" WHERE term_id = :termId
  UNION ALL SELECT s.student_id, ${KEY("COALESCE(c.name, s.class)")}, 'c'
    FROM "dbo"."Student" s LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
    WHERE CAST(:active AS boolean) AND s.is_deleted IS NOT TRUE
)
SELECT class_key AS "classKey", COUNT(DISTINCT student_id)::int AS "roll",
  COUNT(DISTINCT student_id) FILTER (WHERE src = 'k')::int AS "kgPupils"
FROM d WHERE class_key IS NOT NULL AND class_key <> '' GROUP BY class_key`;

const MARKS_CTE = `
m AS (
  SELECT DISTINCT ON (student_id, subject_id, ${KEY()})
    student_id, subject_id, ${KEY()} AS class_key, total_score, grade, remarks
  FROM "dbo"."Student_marks"
  WHERE term_id = :termId AND subject_id IS NOT NULL
  ORDER BY student_id, subject_id, ${KEY()}, student_marks_id DESC
)`;

/** One term, per class and subject: marks entered, their sum, how many passed. */
const SUBJECTS_SQL = `
WITH ${PASS_MARKS}, ${MARKS_CTE}
SELECT m.class_key AS "classKey", m.subject_id AS "subjectId",
  COUNT(*)::int AS "marks", COUNT(m.total_score)::int AS "scored", COALESCE(SUM(m.total_score), 0)::float AS "sumScore",
  COUNT(*) FILTER (WHERE m.total_score >= COALESCE(NULLIF(s.pass_marks, 0), pm.m, CAST(:defaultMark AS numeric)))::int AS "passed"
FROM m LEFT JOIN "dbo"."Subject" s ON s.subject_id = m.subject_id LEFT JOIN pm ON pm.k = m.class_key
GROUP BY m.class_key, m.subject_id`;

/** One term, per class: the grade/remark printed on each subject mark (B8 stamps them). */
const GRADES_SQL = `
WITH ${MARKS_CTE}
SELECT class_key AS "classKey", COALESCE(TRIM(grade), '') AS "grade", COALESCE(TRIM(remarks), '') AS "remark",
  (total_score IS NULL) AS "noScore", COUNT(*)::int AS "count"
FROM m GROUP BY class_key, COALESCE(TRIM(grade), ''), COALESCE(TRIM(remarks), ''), (total_score IS NULL)`;

const PROMOTION_SQL = `
SELECT ${KEY("from_class_name")} AS "classKey", outcome, COUNT(*)::int AS "count"
FROM "dbo"."Student_promotion" WHERE term_id = :termId
GROUP BY ${KEY("from_class_name")}, outcome`;

// --- shared loading ------------------------------------------------------------

const loadClasses = async () =>
  (await Class.findAll({ attributes: ["classId", "name", "section", "isDeleted"], raw: true })).map((c) => ({
    ...c,
    classId: Number(c.classId),
    isDeleted: Boolean(c.isDeleted),
  }));

/** Class key -> class row (a live class beats a removed one of the same name). */
export const classIndex = (classes) => {
  const out = new Map();
  for (const c of classes) {
    const k = classKey(c.name);
    if (!k) continue;
    const prev = out.get(k);
    if (!prev || (prev.isDeleted && !c.isDeleted)) out.set(k, c);
  }
  return out;
};

/** Pure: the pass mark per class key, for the SQL. */
export const passMarksByKey = (rules, classes) => {
  const idx = classIndex(classes);
  const list = [];
  for (const [k, c] of idx) {
    const { passMark, source } = resolvePassMark(rules, c.classId);
    if (source === "class") list.push({ k, m: passMark });
  }
  const { passMark: fallback } = resolvePassMark({ ...rules, classRules: [] }, null);
  return { list, fallback };
};

const passMarkParams = async (classes) => {
  const { list, fallback } = passMarksByKey(await getRules(), classes);
  return { marks: JSON.stringify(list), defaultMark: fallback };
};

const loadYears = async () => {
  const rows = await AcademicYear.findAll({ attributes: ["academicYearId", "name"], raw: true });
  return new Map(rows.map((y) => [Number(y.academicYearId), y.name]));
};

const termOut = (t, years) => ({
  termId: Number(t.termId),
  term: t.term,
  name: termName(t),
  startDate: t.startDate ?? null,
  endDate: t.endDate ?? null,
  active: Boolean(t.active),
  academicYear: t.academicYearId != null ? { academicYearId: Number(t.academicYearId), name: years.get(Number(t.academicYearId)) ?? null } : null,
});

// --- across terms -----------------------------------------------------------------

/**
 * Pure: one row per term (oldest first), every term listed even with no data.
 * results/attendance rows are per term AND class: summed here, so the averages
 * are over pupils, not a mean of class means.
 */
export const buildTermsOverview = ({ terms, years = new Map(), results = [], attendance = [], pupils = [] }) => {
  const byTerm = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const id = Number(r.termId);
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(r);
    }
    return m;
  };
  const res = byTerm(results);
  const att = byTerm(attendance);
  const pup = new Map(pupils.map((p) => [Number(p.termId), num(p.pupils)]));
  return [...terms].sort(termSort).map((t) => {
    const id = Number(t.termId);
    const r = res.get(id) || [];
    const a = att.get(id) || [];
    const sum = (rows, k) => rows.reduce((s, x) => s + num(x[k]), 0);
    const scored = sum(r, "scored");
    const days = sum(a, "days");
    return {
      ...termOut(t, years),
      pupils: pup.get(id) ?? 0,
      pupilsWithResults: sum(r, "pupils"),
      averageScore: mean(sum(r, "sumPct"), scored),
      passRate: rate(sum(r, "passed"), scored),
      daysMarked: days,
      attendanceRate: rate(sum(a, "present"), days),
    };
  });
};

/** GET /reports/academic/terms-overview (Administrator). */
export const getTermsOverview = async () => {
  const [terms, years, classes] = [await Term.findAll({ raw: true }), await loadYears(), await loadClasses()];
  const params = { termId: null, ...(await passMarkParams(classes)) };
  const results = await select(RESULTS_SQL, params);
  const attendance = await select(ATTENDANCE_SQL, { termId: null });
  const pupils = await select(PUPILS_SQL, { termId: null });
  return { terms: buildTermsOverview({ terms, years, results, attendance, pupils }) };
};

// --- one term ---------------------------------------------------------------------

const RANK_SIZE = 3;

/** Pure: grade buckets per grading scale, in the scale's order (best first), zero counts kept. */
export const buildGradeDistribution = ({ grades, classesByKey, scales }) => {
  const groups = new Map(); // scale name -> { scale, bands, counts: Map label->count }
  for (const g of grades) {
    const klass = classesByKey.get(g.classKey);
    if (klass && isKgSection(klass.section)) continue;
    const scale = pickScale(scales, klass?.section);
    const name = scale?.name || "Built-in";
    const bands = scale?.bands || DEFAULT_PRIMARY_BANDS;
    if (!groups.has(name)) groups.set(name, { name, bands, counts: new Map(), classes: new Set() });
    const grp = groups.get(name);
    grp.classes.add(klass?.name || g.classKey);
    const label = g.noScore ? "No score" : g.grade || g.remark || "Ungraded";
    grp.counts.set(label, (grp.counts.get(label) || 0) + num(g.count));
  }
  return [...groups.values()].map((grp) => {
    // Bands best first; several bands can share a remark (JHS 1 and 2 are both "Excellent").
    const ordered = [...grp.bands].sort((a, b) => Number(b.minScore) - Number(a.minScore));
    const seen = new Set();
    const buckets = [];
    for (const b of ordered) {
      const label = b.grade ? String(b.grade) : b.remark;
      if (!label || seen.has(label)) continue;
      seen.add(label);
      buckets.push({ label, remark: b.grade ? b.remark ?? null : null, minScore: Number(b.minScore), count: grp.counts.get(label) || 0 });
    }
    const extra = [...grp.counts.keys()].filter((l) => !seen.has(l)).sort((a, b) => ["Ungraded", "No score"].indexOf(a) - ["Ungraded", "No score"].indexOf(b) || a.localeCompare(b));
    for (const label of extra) buckets.push({ label, remark: null, minScore: null, count: grp.counts.get(label) });
    const total = buckets.reduce((s, b) => s + b.count, 0);
    return {
      scale: grp.name,
      classes: [...grp.classes].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })),
      total,
      buckets: buckets.map((b) => ({ ...b, share: rate(b.count, total) })),
    };
  });
};

/**
 * Pure: everything for one term. Classes appear when they have any data that
 * term (or pupils on roll, in the open term). Classes whose name no longer
 * exists keep their old name, with classId null.
 */
export const buildTermDetail = ({
  term,
  years = new Map(),
  classes,
  results = [],
  attendance = [],
  pupils = [],
  roster = [],
  subjectRows = [],
  subjects = [],
  grades = [],
  promotions = [],
  scales = [],
  rules = { defaultPassMark: null, classRules: [] },
}) => {
  const idx = classIndex(classes);
  const subjectName = new Map(subjects.map((s) => [Number(s.subjectId), { name: s.name, removed: Boolean(s.isDeleted), passMarks: num(s.passMarks) }]));
  const keyed = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = r.classKey ?? null;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const res = keyed(results);
  const att = keyed(attendance);
  const rol = keyed(roster);
  const subs = keyed(subjectRows);
  const prom = keyed(promotions);
  const keys = new Set([...res.keys(), ...att.keys(), ...rol.keys(), ...subs.keys(), ...prom.keys()].filter((k) => k));
  const sum = (rows, k) => (rows || []).reduce((s, x) => s + num(x[k]), 0);
  const nameOfKey = (k) => String(idx.get(k)?.name ?? res.get(k)?.[0]?.className ?? k).trim();

  const classRows = [...keys].map((k) => {
    const c = idx.get(k) || null;
    const kg = c ? isKgSection(c.section) : false;
    const r = res.get(k);
    const a = att.get(k);
    const s = subs.get(k) || [];
    const roll = sum(rol.get(k), "roll");
    const started = s.filter((x) => num(x.marks) > 0).length;
    const marksRecorded = sum(s, "marks");
    const marksExpected = roll * started;
    const withResults = kg ? sum(rol.get(k), "kgPupils") : sum(r, "pupils");
    return {
      classId: c?.classId ?? null,
      classKey: k,
      name: nameOfKey(k),
      section: c?.section ?? null,
      isKg: kg,
      removed: c ? c.isDeleted : true,
      passMark: c ? resolvePassMark(rules, c.classId).passMark : resolvePassMark(rules, null).passMark,
      roll,
      pupilsWithResults: withResults,
      averageScore: kg ? null : mean(sum(r, "sumPct"), sum(r, "scored")),
      passRate: kg ? null : rate(sum(r, "passed"), sum(r, "scored")),
      daysMarked: sum(a, "days"),
      attendanceRate: rate(sum(a, "present"), sum(a, "days")),
      completeness: {
        // KG: pupils with an assessment; others: subject marks entered for the
        // subjects the class has started (a subject with no marks may not be taught).
        resultsEntered: withResults,
        subjectsStarted: started,
        marksRecorded: kg ? null : marksRecorded,
        marksExpected: kg ? null : marksExpected,
        percent: kg ? rate(withResults, roll) : rate(Math.min(marksRecorded, marksExpected), marksExpected),
      },
      subjects: s
        .map((x) => ({
          subjectId: Number(x.subjectId),
          name: subjectName.get(Number(x.subjectId))?.name ?? "Subject no longer listed",
          marks: num(x.marks),
          average: mean(x.sumScore, x.scored),
          passRate: rate(x.passed, x.scored),
        }))
        .sort((p, q) => String(p.name).localeCompare(String(q.name))),
      promotion: (prom.get(k) || []).reduce((o, p) => ({ ...o, [p.outcome]: (o[p.outcome] || 0) + num(p.count) }), {}),
    };
  });
  classRows.sort((p, q) => String(p.name).localeCompare(String(q.name), undefined, { numeric: true }));

  // Attendance for pupils whose class wasn't recorded (rolled up, no results).
  const unknownAtt = att.get(null);
  const unclassified = unknownAtt ? { daysMarked: sum(unknownAtt, "days"), attendanceRate: rate(sum(unknownAtt, "present"), sum(unknownAtt, "days")), label: UNKNOWN_CLASS } : null;

  // Top / bottom classes by average score (competition ranking; no overlap).
  const ranked = competitionRank(classRows, (c) => c.classKey, (c) => c.averageScore);
  const withRank = classRows.map((c) => ({ ...c, rank: ranked.get(c.classKey) ?? null }));
  const scoredClasses = withRank.filter((c) => c.rank != null).sort((p, q) => p.rank - q.rank || String(p.name).localeCompare(String(q.name)));
  const top = scoredClasses.slice(0, RANK_SIZE);
  const bottom = scoredClasses.slice(Math.max(RANK_SIZE, scoredClasses.length - RANK_SIZE)).reverse();
  const brief = (c) => ({ classId: c.classId, classKey: c.classKey, name: c.name, averageScore: c.averageScore, passRate: c.passRate, rank: c.rank });

  // School-wide per subject.
  const perSubject = new Map();
  for (const x of subjectRows) {
    const id = Number(x.subjectId);
    const p = perSubject.get(id) || { subjectId: id, marks: 0, scored: 0, sumScore: 0, passed: 0, classes: 0 };
    p.marks += num(x.marks);
    p.scored += num(x.scored);
    p.sumScore += num(x.sumScore);
    p.passed += num(x.passed);
    p.classes += 1;
    perSubject.set(id, p);
  }
  const subjectSummary = [...perSubject.values()]
    .map((p) => ({
      subjectId: p.subjectId,
      name: subjectName.get(p.subjectId)?.name ?? "Subject no longer listed",
      classes: p.classes,
      marks: p.marks,
      average: mean(p.sumScore, p.scored),
      passRate: rate(p.passed, p.scored),
    }))
    .sort((p, q) => String(p.name).localeCompare(String(q.name)));

  // Promotion outcomes (B5). Pending = pupils with results not yet decided.
  const decided = { PROMOTED: 0, REPEATED: 0, GRADUATED: 0 };
  for (const p of promotions) decided[p.outcome] = (decided[p.outcome] || 0) + num(p.count);
  const decidedTotal = Object.values(decided).reduce((a, b) => a + b, 0);
  const withAnyResult = withRank.reduce((s, c) => s + c.pupilsWithResults, 0);

  const overview = buildTermsOverview({ terms: [term], years, results, attendance, pupils })[0];
  const scoredRows = withRank.filter((c) => !c.isKg);
  return {
    term: termOut(term, years),
    totals: {
      pupils: overview.pupils,
      pupilsWithResults: overview.pupilsWithResults,
      averageScore: overview.averageScore,
      passRate: overview.passRate,
      attendanceRate: overview.attendanceRate,
      daysMarked: overview.daysMarked,
      classes: withRank.length,
      completeness: rate(
        scoredRows.reduce((s, c) => s + Math.min(c.completeness.marksRecorded ?? 0, c.completeness.marksExpected ?? 0), 0),
        scoredRows.reduce((s, c) => s + (c.completeness.marksExpected ?? 0), 0)
      ),
    },
    classes: withRank,
    unclassifiedAttendance: unclassified,
    ranking: { top: top.map(brief), bottom: bottom.map(brief) },
    subjects: subjectSummary,
    gradeDistribution: buildGradeDistribution({ grades, classesByKey: idx, scales }),
    promotion: { ...decided, decided: decidedTotal, pending: decidedTotal ? Math.max(0, withAnyResult - decidedTotal) : null },
  };
};

const loadTerm = async (termId) => {
  const term = await Term.findOne({ where: { termId: toInt(termId, "termId") }, raw: true });
  if (!term) throw new AppError("Term not found", 404);
  return term;
};

/** GET /reports/academic/term/:termId (Administrator). */
export const getTermReport = async (termId) => {
  const term = await loadTerm(termId);
  const id = Number(term.termId);
  // One query at a time (a small pool; reports are not hot paths).
  const years = await loadYears();
  const classes = await loadClasses();
  const rules = await getRules();
  const { list, fallback } = passMarksByKey(rules, classes);
  const marks = { marks: JSON.stringify(list), defaultMark: fallback };
  const results = await select(RESULTS_SQL, { termId: id, ...marks });
  const attendance = await select(ATTENDANCE_SQL, { termId: id });
  const pupils = await select(PUPILS_SQL, { termId: id });
  const roster = await select(ROSTER_SQL, { termId: id, active: Boolean(term.active) });
  const subjectRows = await select(SUBJECTS_SQL, { termId: id, ...marks });
  const grades = await select(GRADES_SQL, { termId: id });
  const promotions = await select(PROMOTION_SQL, { termId: id });
  const subjects = await Subject.findAll({ attributes: ["subjectId", "name", "isDeleted", "passMarks"], raw: true });
  const scales = await listScales();
  return buildTermDetail({ term, years, classes, results, attendance, pupils, roster, subjectRows, subjects, grades, promotions, scales, rules });
};

// --- one class in one term (drill-down) ------------------------------------------------

const CLASS_RESULTS_SQL = `
SELECT DISTINCT ON (student_id) student_id AS "studentId", raw_score AS "rawScore", total_raw_score AS "totalRawScore"
FROM "dbo"."Student_result" WHERE term_id = :termId AND ${KEY()} = :key
ORDER BY student_id, student_result_id DESC`;

const CLASS_MARKS_SQL = `
SELECT DISTINCT ON (student_id, subject_id) student_id AS "studentId", subject_id AS "subjectId", total_score AS "totalScore", grade, remarks
FROM "dbo"."Student_marks" WHERE term_id = :termId AND ${KEY()} = :key AND subject_id IS NOT NULL
ORDER BY student_id, subject_id, student_marks_id DESC`;

/**
 * Pure: one class's term, pupil by pupil and subject by subject. Subjects list
 * the pupils below the pass mark (lowest first) for the drill-down.
 */
export const buildClassReport = ({ passMark, results = [], marks = [], subjects = [], names = new Map(), attendance = [] }) => {
  const nameOf = (id) => names.get(Number(id)) || `Pupil ${id}`;
  const att = new Map(attendance.map((a) => [Number(a.studentId), a]));
  const pupils = results.map((r) => {
    const total = Number(r.totalRawScore);
    const score = total > 0 && Number.isFinite(Number(r.rawScore)) ? round1((Number(r.rawScore) / total) * 100) : null;
    const a = att.get(Number(r.studentId));
    return {
      studentId: Number(r.studentId),
      name: nameOf(r.studentId),
      score,
      passed: score == null ? null : score >= passMark,
      present: a ? num(a.present) : null,
      daysMarked: a ? num(a.total) : null,
      attendanceRate: a ? rate(a.present, a.total) : null,
    };
  });
  const pos = competitionRank(pupils, (p) => p.studentId, (p) => p.score);
  const rankedPupils = pupils
    .map((p) => ({ ...p, position: pos.get(p.studentId) ?? null }))
    .sort((p, q) => (p.position ?? Infinity) - (q.position ?? Infinity) || p.name.localeCompare(q.name));

  const info = new Map(subjects.map((s) => [Number(s.subjectId), s]));
  const bySubject = new Map();
  for (const m of marks) {
    const id = Number(m.subjectId);
    if (!bySubject.has(id)) bySubject.set(id, []);
    bySubject.get(id).push(m);
  }
  const subjectRows = [...bySubject.entries()].map(([id, rows]) => {
    const s = info.get(id);
    const mark = s && num(s.passMarks) > 0 ? num(s.passMarks) : passMark;
    const scored = rows.filter((m) => m.totalScore !== null && m.totalScore !== undefined && Number.isFinite(Number(m.totalScore)));
    const below = scored
      .filter((m) => Number(m.totalScore) < mark)
      .map((m) => ({ studentId: Number(m.studentId), name: nameOf(m.studentId), score: Number(m.totalScore), grade: m.grade || null, remark: m.remarks || null }))
      .sort((p, q) => p.score - q.score || p.name.localeCompare(q.name));
    return {
      subjectId: id,
      name: s?.name ?? "Subject no longer listed",
      passMark: mark,
      marks: rows.length,
      average: mean(scored.reduce((t, m) => t + Number(m.totalScore), 0), scored.length),
      passRate: rate(scored.length - below.length, scored.length),
      below,
    };
  });
  subjectRows.sort((p, q) => String(p.name).localeCompare(String(q.name)));
  const scored = rankedPupils.filter((p) => p.score != null);
  const days = attendance.reduce((t, a) => t + num(a.total), 0);
  return {
    totals: {
      pupils: rankedPupils.length,
      averageScore: mean(scored.reduce((t, p) => t + p.score, 0), scored.length),
      passRate: rate(scored.filter((p) => p.passed).length, scored.length),
      attendanceRate: rate(attendance.reduce((t, a) => t + num(a.present), 0), days),
      daysMarked: days,
    },
    pupils: rankedPupils,
    subjects: subjectRows,
  };
};

/** GET /reports/academic/term/:termId/class/:classId (Administrator; Class Teacher: own class). */
export const getClassTermReport = async ({ termId, classId }, user) => {
  const klass = await Class.findOne({ where: { classId: toInt(classId, "classId") }, raw: true });
  if (!klass) throw new AppError("Class not found", 404);
  try {
    await assertClassAccess(user, klass.name);
  } catch (e) {
    throw new AppError("You can only see reports for your own class", e.statusCode || 403);
  }
  const term = await loadTerm(termId);
  const years = await loadYears();
  const kg = isKgSection(klass.section);
  const { passMark } = resolvePassMark(await getRules(), klass.classId);
  const key = classKey(klass.name);
  const results = kg ? [] : await select(CLASS_RESULTS_SQL, { termId: Number(term.termId), key });
  const marks = kg ? [] : await select(CLASS_MARKS_SQL, { termId: Number(term.termId), key });
  const subjects = kg ? [] : await Subject.findAll({ attributes: ["subjectId", "name", "passMarks"], raw: true });
  // Attendance per pupil: the B7 summary (same roster and roll-up rules).
  const summary = await getClassAttendanceSummary({ classId: klass.classId, termId: term.termId }, user);
  const attendance = summary.students || [];
  const ids = [...new Set([...results.map((r) => Number(r.studentId)), ...attendance.map((a) => Number(a.studentId))])];
  const names = new Map(attendance.map((a) => [Number(a.studentId), a.name]).filter(([, n]) => n));
  const missing = ids.filter((id) => !names.has(id));
  if (missing.length) {
    const rows = await Student.findAll({ where: { studentId: missing }, attributes: ["studentId", "fName", "mName", "lName"], raw: true });
    for (const s of rows) names.set(Number(s.studentId), fullName(s));
  }
  // KG / classes with attendance only: list every pupil on the register.
  const resultRows = kg ? attendance.map((a) => ({ studentId: a.studentId, rawScore: null, totalRawScore: null })) : results;
  const extra = kg ? [] : attendance.filter((a) => !results.some((r) => Number(r.studentId) === Number(a.studentId)));
  const report = buildClassReport({
    passMark,
    results: [...resultRows, ...extra.map((a) => ({ studentId: a.studentId, rawScore: null, totalRawScore: null }))],
    marks,
    subjects,
    names,
    attendance,
  });
  return {
    class: { classId: Number(klass.classId), name: String(klass.name ?? "").trim(), section: klass.section, isKg: kg },
    term: termOut(term, years),
    passMark,
    ...report,
  };
};
