import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Class, GradeBand, GradingScale, GradingScaleSection } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// ---------------------------------------------------------------------------
// B8: the school's grading scales (db/migrations/032_grading_scales.sql).
//
// Rules (ported from SchoolPro grading.service.ts, plus our own):
//  - A scale is a list of bands: { grade (optional, e.g. "1" or "A1"), remark
//    (e.g. "Excellent"), minScore, maxScore } on the 0–100 subject total.
//  - Bands: min <= max, both 0–100, no overlap (touching is fine: 0–40 then
//    40–50), gaps allowed, the lowest band starts at 0 (so every score gets a
//    remark), no two bands with the same grade or the same start.
//  - resolveGrade: the band with the HIGHEST min <= score. max is ignored, so
//    49.8 on whole-number bands (40–49, 50–59) is still graded (it's 40–49).
//  - A class uses the scale linked to its section (Class.section), else the
//    default scale; a scale with no bands is ignored. With no scale at all the
//    built-in bands below are used (what the system did before B8).
//  - The grade and remark are stamped on Student_marks when a mark is saved,
//    so editing a scale applies from then on and old report cards don't change
//    (client question B8.2, going-forward default).
// ---------------------------------------------------------------------------

/** What every class printed before B8 (services/results.js gradeRemark). */
export const DEFAULT_PRIMARY_BANDS = [
  { grade: null, remark: "Fail", minScore: 0, maxScore: 39.99 },
  { grade: null, remark: "Pass", minScore: 40, maxScore: 49.99 },
  { grade: null, remark: "Credit", minScore: 50, maxScore: 59.99 },
  { grade: null, remark: "Good", minScore: 60, maxScore: 69.99 },
  { grade: null, remark: "Very Good", minScore: 70, maxScore: 79.99 },
  { grade: null, remark: "Excellent", minScore: 80, maxScore: 100 },
];

/**
 * JHS (BECE 1–9) as the portal report card printed it (ResultsContent getGrade),
 * with the remark each score already got from the bands above, so JHS cards
 * show the same grade AND the same remark as before.
 */
export const DEFAULT_JHS_BANDS = [
  { grade: "9", remark: "Fail", minScore: 0, maxScore: 34.99 },
  { grade: "8", remark: "Fail", minScore: 35, maxScore: 39.99 },
  { grade: "7", remark: "Pass", minScore: 40, maxScore: 49.99 },
  { grade: "6", remark: "Credit", minScore: 50, maxScore: 54.99 },
  { grade: "5", remark: "Credit", minScore: 55, maxScore: 59.99 },
  { grade: "4", remark: "Good", minScore: 60, maxScore: 69.99 },
  { grade: "3", remark: "Very Good", minScore: 70, maxScore: 79.99 },
  { grade: "2", remark: "Excellent", minScore: 80, maxScore: 89.99 },
  { grade: "1", remark: "Excellent", minScore: 90, maxScore: 100 },
];

const GRADE_MAX = 10; // Student_marks.grade VARCHAR(10)
const REMARK_MAX = 50; // Student_marks.remarks VARCHAR(50) (widened in 032)
const NAME_MAX = 100;
const SCORE_RE = /^\d+(\.\d{1,2})?$/;

const text = (v) => (v == null ? "" : String(v).trim());
const normSection = (s) => text(s).toLowerCase().replace(/\s+/g, " ");

/**
 * Pure: the band for a score, as { grade, remark }, or null (not a number,
 * negative, or below the lowest band). Doesn't reorder `bands`.
 */
export const resolveGrade = (score, bands) => {
  if (score == null || text(score) === "") return null;
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0 || !Array.isArray(bands)) return null;
  let best = null;
  for (const b of bands) {
    const min = Number(b.minScore);
    if (Number.isFinite(min) && min <= s && (!best || min > Number(best.minScore))) best = b;
  }
  return best ? { grade: best.grade ? String(best.grade) : null, remark: best.remark ?? null } : null;
};

/**
 * Pure: checks and tidies a list of bands. Returns them sorted low to high
 * with numbers and trimmed text; throws AppError 400 naming the problem.
 */
export const validateBands = (bands) => {
  if (!Array.isArray(bands) || bands.length === 0) throw new AppError("Add at least one grade band", 400);
  if (bands.length > 30) throw new AppError("A scale can have at most 30 bands", 400);
  const clean = bands.map((b, i) => {
    const grade = text(b?.grade) || null;
    const remark = text(b?.remark);
    const label = grade || remark || `Band ${i + 1}`;
    if (!remark) throw new AppError(`Band ${i + 1}: enter a remark (e.g. "Excellent")`, 400);
    if (remark.length > REMARK_MAX) throw new AppError(`"${label}": the remark can be at most ${REMARK_MAX} characters`, 400);
    if (grade && grade.length > GRADE_MAX) throw new AppError(`"${label}": the grade can be at most ${GRADE_MAX} characters`, 400);
    for (const [key, name] of [["minScore", "lowest"], ["maxScore", "highest"]]) {
      if (!SCORE_RE.test(text(b?.[key]))) {
        throw new AppError(`"${label}": the ${name} score must be a number from 0 to 100 (at most 2 decimal places)`, 400);
      }
    }
    const minScore = Number(b.minScore);
    const maxScore = Number(b.maxScore);
    if (minScore > 100 || maxScore > 100) throw new AppError(`"${label}": scores go from 0 to 100`, 400);
    if (minScore > maxScore) throw new AppError(`"${label}": the lowest score (${minScore}) is above the highest (${maxScore})`, 400);
    return { grade, remark, minScore, maxScore };
  });

  const sorted = [...clean].sort((a, b) => a.minScore - b.minScore);
  if (sorted[0].minScore !== 0) {
    throw new AppError(`The lowest band must start at 0 (it starts at ${sorted[0].minScore}), so every score gets a remark`, 400);
  }
  const grades = new Set();
  for (let i = 0; i < sorted.length; i += 1) {
    const b = sorted[i];
    const key = b.grade?.toLowerCase();
    if (key) {
      if (grades.has(key)) throw new AppError(`The grade "${b.grade}" is used twice`, 400);
      grades.add(key);
    }
    const next = sorted[i + 1];
    if (!next) continue;
    const name = (x) => x.grade || x.remark;
    if (next.minScore === b.minScore) {
      throw new AppError(`"${name(b)}" and "${name(next)}" both start at ${b.minScore}`, 400);
    }
    if (b.maxScore > next.minScore) {
      throw new AppError(`"${name(b)}" (${b.minScore}–${b.maxScore}) overlaps "${name(next)}" (${next.minScore}–${next.maxScore})`, 400);
    }
  }
  return sorted;
};

const bandView = (b) => ({
  gradeBandId: b.gradeBandId,
  grade: b.grade || null,
  remark: b.remark,
  minScore: Number(b.minScore),
  maxScore: Number(b.maxScore),
});
const byMin = (a, b) => a.minScore - b.minScore;

/** Every scale with its bands (low to high) and linked sections. */
export const listScales = async ({ transaction = null } = {}) => {
  const [scales, bands, links] = [
    await GradingScale.findAll({ order: [["name", "ASC"]], raw: true, transaction }),
    await GradeBand.findAll({ raw: true, transaction }),
    await GradingScaleSection.findAll({ raw: true, transaction }),
  ];
  return scales.map((s) => ({
    gradingScaleId: s.gradingScaleId,
    name: s.name,
    isDefault: !!s.isDefault,
    bands: bands.filter((b) => b.gradingScaleId === s.gradingScaleId).map(bandView).sort(byMin),
    sections: links.filter((l) => l.gradingScaleId === s.gradingScaleId).map((l) => l.section).sort(),
  }));
};

/** Pure: the scale for a section from listScales() output, or the default. */
export const pickScale = (scales, section) => {
  const usable = (scales || []).filter((s) => s.bands?.length);
  const key = normSection(section);
  return (
    (key && usable.find((s) => s.sections.some((x) => normSection(x) === key))) ||
    usable.find((s) => s.isDefault) ||
    null
  );
};

/** Bands for a class section: its scale, the default, or the built-in bands. */
export const bandsForSection = async (section, { transaction = null } = {}) => {
  const scale = pickScale(await listScales({ transaction }), section);
  return scale
    ? { gradingScaleId: scale.gradingScaleId, name: scale.name, bands: scale.bands }
    : { gradingScaleId: null, name: "Built-in", bands: DEFAULT_PRIMARY_BANDS };
};

/** The section of a class, by class name (results rows carry the name). */
export const sectionOfClass = async (className, { transaction = null } = {}) => {
  if (!text(className)) return null;
  const rows = await Class.findAll({
    // Live has names like " NURSERY 2": compare trimmed, ignoring case.
    where: sequelize.where(sequelize.fn("lower", sequelize.fn("trim", sequelize.col("name"))), text(className).toLowerCase()),
    attributes: ["section", "isDeleted"],
    raw: true,
    transaction,
  });
  const row = rows.find((r) => !r.isDeleted) || rows[0];
  return row?.section ?? null;
};

/**
 * A grader for one save: `grade(score, className)` -> { grade, remark }.
 * Scales and class sections are read once per grader (cache per request).
 */
export const makeGrader = ({ transaction = null } = {}) => {
  let scalesP = null;
  const sections = new Map();
  return async (score, className) => {
    // One query at a time: inside a transaction they share one connection.
    scalesP ??= listScales({ transaction });
    const scales = await scalesP;
    const key = text(className).toLowerCase();
    if (!sections.has(key)) sections.set(key, sectionOfClass(className, { transaction }));
    const section = await sections.get(key);
    const scale = pickScale(scales, section);
    return resolveGrade(score, scale ? scale.bands : DEFAULT_PRIMARY_BANDS) || { grade: null, remark: null };
  };
};

// ---- office CRUD (Administrator) ---------------------------------------------

const cleanSections = (sections) => {
  if (sections == null) return [];
  if (!Array.isArray(sections)) throw new AppError("sections must be a list", 400);
  const out = [];
  for (const s of sections) {
    const v = text(s);
    if (!v) continue;
    if (v.length > 50) throw new AppError("A section name can be at most 50 characters", 400);
    if (!out.some((x) => normSection(x) === normSection(v))) out.push(v);
  }
  return out;
};

const cleanScale = (body) => {
  const name = text(body?.name);
  if (!name) throw new AppError("Give the scale a name", 400);
  if (name.length > NAME_MAX) throw new AppError(`The name can be at most ${NAME_MAX} characters`, 400);
  return { name, isDefault: body?.isDefault === true, bands: validateBands(body?.bands), sections: cleanSections(body?.sections) };
};

const writeScale = async (id, data, t) => {
  const others = await GradingScale.findAll({ raw: true, transaction: t });
  if (others.some((s) => s.gradingScaleId !== id && text(s.name).toLowerCase() === data.name.toLowerCase())) throw new AppError(`A scale named "${data.name}" already exists`, 409);

  if (data.isDefault) {
    await GradingScale.update({ isDefault: false }, { where: { gradingScaleId: { [Op.ne]: id } }, transaction: t });
  }
  await GradingScale.update({ name: data.name, isDefault: data.isDefault }, { where: { gradingScaleId: id }, transaction: t });

  // Replace the bands and the section links (a section moves off any other scale).
  await GradeBand.destroy({ where: { gradingScaleId: id }, transaction: t });
  for (const b of data.bands) await GradeBand.create({ ...b, gradingScaleId: id }, { transaction: t });
  await GradingScaleSection.destroy({ where: { gradingScaleId: id }, transaction: t });
  const all = await GradingScaleSection.findAll({ raw: true, transaction: t });
  for (const section of data.sections) {
    const taken = all.filter((l) => normSection(l.section) === normSection(section));
    for (const l of taken) await GradingScaleSection.destroy({ where: { section: l.section }, transaction: t });
    await GradingScaleSection.create({ gradingScaleId: id, section }, { transaction: t });
  }

  const defaults = await GradingScale.count({ where: { isDefault: true }, transaction: t });
  if (!defaults) throw new AppError("One scale must be the default (it grades classes with no scale of their own)", 400);
};

const lockScales = (t) => sequelize.query('LOCK TABLE "dbo"."Grading_scale" IN SHARE ROW EXCLUSIVE MODE', { transaction: t });

export const createScale = async (body) => {
  const data = cleanScale(body);
  return sequelize.transaction(async (t) => {
    await lockScales(t);
    const row = await GradingScale.create({ name: data.name, isDefault: false }, { transaction: t });
    await writeScale(row.gradingScaleId, data, t);
    return (await listScales({ transaction: t })).find((s) => s.gradingScaleId === row.gradingScaleId);
  });
};

export const updateScale = async (id, body) => {
  const scaleId = Number(id);
  if (!Number.isInteger(scaleId) || scaleId <= 0) throw new AppError("Scale not found", 404);
  const data = cleanScale(body);
  return sequelize.transaction(async (t) => {
    await lockScales(t);
    const row = await GradingScale.findOne({ where: { gradingScaleId: scaleId }, raw: true, transaction: t });
    if (!row) throw new AppError("Scale not found", 404);
    await writeScale(scaleId, data, t);
    return (await listScales({ transaction: t })).find((s) => s.gradingScaleId === scaleId);
  });
};

export const deleteScale = async (id) => {
  const scaleId = Number(id);
  return sequelize.transaction(async (t) => {
    await lockScales(t);
    const row = await GradingScale.findOne({ where: { gradingScaleId: scaleId }, raw: true, transaction: t });
    if (!row) throw new AppError("Scale not found", 404);
    if (row.isDefault) throw new AppError("This is the default scale. Make another scale the default first.", 400);
    await GradeBand.destroy({ where: { gradingScaleId: scaleId }, transaction: t });
    await GradingScaleSection.destroy({ where: { gradingScaleId: scaleId }, transaction: t });
    await GradingScale.destroy({ where: { gradingScaleId: scaleId }, transaction: t });
    return { deleted: scaleId };
  });
};

/** The bands that grade a class (for live previews on the score screens). */
export const bandsForClass = async (className) => bandsForSection(await sectionOfClass(className));
