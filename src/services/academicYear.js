import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AcademicYear, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// ---------------------------------------------------------------------------
// B7: academic years (migration 029). Ported from SchoolPro's
// academic-years.service, with the gaps it has closed:
//   - a year has dates, and its terms must sit inside them;
//   - every activation goes through one path (activating a term makes its
//     year current; the previous current year is completed);
//   - status changes are limited to the moves that make sense.
// Status: UPCOMING -> ACTIVE (made current) -> COMPLETED. A completed year can
// be made current again (reopened) by an Administrator.
// ---------------------------------------------------------------------------

export const YEAR_STATUSES = ["UPCOMING", "ACTIVE", "COMPLETED"];
export const NAME_MIN = 2;
export const NAME_MAX = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-09-08" (or a timestamp) -> "2026-09-08"; refuses impossible dates like 30 Feb. */
export const toDateOnly = (value, label) => {
  const s = String(value ?? "").slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new AppError(`${label} must be a valid date`, 400);
  }
  return s;
};

const toId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${what} not found`, 404);
  return n;
};

export const termName = (t) => (t?.term != null && String(t.term).trim() !== "" ? `Term ${String(t.term).trim()}` : "Term (no number)");

/** Pure: validates a year's name and dates. Returns the clean values. */
export const validateYearInput = ({ name, startDate, endDate } = {}) => {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) {
    throw new AppError(`The year's name must be ${NAME_MIN}–${NAME_MAX} characters, e.g. 2026/2027`, 400);
  }
  if (!startDate || !endDate) throw new AppError("The year's start and end dates are required", 400);
  const start = toDateOnly(startDate, "Start date");
  const end = toDateOnly(endDate, "End date");
  if (start >= end) throw new AppError("The year must start before it ends", 400);
  return { name: clean, startDate: start, endDate: end };
};

const assertNameFree = async (name, excludeId, transaction) => {
  const where = { name: { [Op.iLike]: name.replace(/[\\%_]/g, (c) => `\\${c}`) } };
  if (excludeId != null) where.academicYearId = { [Op.ne]: excludeId };
  const clash = await AcademicYear.findOne({ where, raw: true, transaction });
  if (clash) throw new AppError(`There is already a year called ${clash.name}`, 409);
};

const assertNoYearOverlap = async ({ startDate, endDate }, excludeId, transaction) => {
  const where = { startDate: { [Op.lte]: endDate }, endDate: { [Op.gte]: startDate } };
  if (excludeId != null) where.academicYearId = { [Op.ne]: excludeId };
  const clash = await AcademicYear.findOne({ where, raw: true, transaction });
  if (clash) throw new AppError(`These dates overlap the year ${clash.name}`, 400);
};

/** Years, newest first, each with its terms (oldest first); plus terms that have no year. */
export const listYears = async () => {
  const years = await AcademicYear.findAll({ order: [["startDate", "DESC"], ["academicYearId", "DESC"]], raw: true });
  const terms = await Term.findAll({ order: [["startDate", "ASC"], ["termId", "ASC"]], raw: true });
  const byYear = new Map(years.map((y) => [y.academicYearId, []]));
  const unassigned = [];
  for (const t of terms) {
    const list = t.academicYearId != null ? byYear.get(t.academicYearId) : null;
    (list || unassigned).push(t);
  }
  return {
    years: years.map((y) => ({ ...y, terms: byYear.get(y.academicYearId) })),
    unassignedTerms: unassigned,
  };
};

export const getYear = async (id, { transaction = null, lock = false } = {}) => {
  const year = await AcademicYear.findOne({
    where: { academicYearId: toId(id, "Academic year") },
    raw: true,
    transaction,
    ...(lock && transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!year) throw new AppError("Academic year not found", 404);
  return year;
};

export const createYear = async (data = {}) => {
  const clean = validateYearInput(data);
  return sequelize.transaction(async (transaction) => {
    await assertNameFree(clean.name, null, transaction);
    await assertNoYearOverlap(clean, null, transaction);
    const row = await AcademicYear.create({ ...clean, status: "UPCOMING", isCurrent: false }, { transaction });
    return typeof row?.toJSON === "function" ? row.toJSON() : row;
  });
};

/**
 * Makes `id` the current year (status ACTIVE). The previous current year is
 * COMPLETED when it ended before this one starts, otherwise put back to
 * UPCOMING (it was made current by mistake). Runs inside the caller's
 * transaction when given (term activation).
 */
export const setCurrentYear = async (id, { transaction = null } = {}) => {
  const run = async (t) => {
    const year = await getYear(id, { transaction: t, lock: true });
    const others = await AcademicYear.findAll({
      where: { academicYearId: { [Op.ne]: year.academicYearId }, [Op.or]: [{ isCurrent: true }, { status: "ACTIVE" }] },
      raw: true,
      transaction: t,
    });
    // One at a time (one connection); clear the old current year first because
    // of the "one current year" unique index.
    for (const o of others) {
      await AcademicYear.update(
        { isCurrent: false, status: String(o.endDate) < String(year.startDate) ? "COMPLETED" : "UPCOMING" },
        { where: { academicYearId: o.academicYearId }, transaction: t }
      );
    }
    await AcademicYear.update({ isCurrent: true, status: "ACTIVE" }, { where: { academicYearId: year.academicYearId }, transaction: t });
    return { ...year, isCurrent: true, status: "ACTIVE" };
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
};

export const updateYear = async (id, data = {}) =>
  sequelize.transaction(async (transaction) => {
    const year = await getYear(id, { transaction, lock: true });
    const clean = validateYearInput({
      name: data.name ?? year.name,
      startDate: data.startDate ?? year.startDate,
      endDate: data.endDate ?? year.endDate,
    });
    if (clean.name.toLowerCase() !== String(year.name).toLowerCase()) await assertNameFree(clean.name, year.academicYearId, transaction);
    await assertNoYearOverlap(clean, year.academicYearId, transaction);

    // Its terms must still fit inside the new dates.
    const terms = await Term.findAll({ where: { academicYearId: year.academicYearId }, raw: true, transaction });
    const outside = terms.filter(
      (t) => (t.startDate && String(t.startDate) < clean.startDate) || (t.endDate && String(t.endDate) > clean.endDate)
    );
    if (outside.length) {
      throw new AppError(`${outside.map(termName).join(", ")} would fall outside the year's dates. Change the term first.`, 400);
    }

    const patch = { ...clean };
    if (data.status != null && data.status !== year.status) {
      const status = String(data.status).toUpperCase();
      if (!YEAR_STATUSES.includes(status)) throw new AppError("Unknown status", 400);
      if (status === "ACTIVE") {
        throw new AppError("Use “Make current” to make a year active", 400);
      }
      if (terms.some((t) => t.active)) {
        throw new AppError("This year has the open term. Close the term before changing the year's status.", 409);
      }
      patch.status = status;
      patch.isCurrent = false;
    }
    await AcademicYear.update(patch, { where: { academicYearId: year.academicYearId }, transaction });
    return { ...year, ...patch };
  });

export const deleteYear = async (id) =>
  sequelize.transaction(async (transaction) => {
    const year = await getYear(id, { transaction, lock: true });
    const count = await Term.count({ where: { academicYearId: year.academicYearId }, transaction });
    if (count > 0) {
      throw new AppError(`${year.name} still has ${count} term${count === 1 ? "" : "s"}. Delete or move them first.`, 400);
    }
    await AcademicYear.destroy({ where: { academicYearId: year.academicYearId }, transaction });
    return { deleted: true, academicYearId: year.academicYearId };
  });

/**
 * The year a term being created or edited goes into (locked for the rest of
 * the transaction, so two terms added at once are checked one after the
 * other). Uses `academicYearId` when given, otherwise the year whose dates
 * contain the term's start date. `required`: no year found -> 400.
 */
export const resolveTermYear = async ({ academicYearId, startDate } = {}, { transaction = null, required = true } = {}) => {
  if (academicYearId != null && academicYearId !== "") {
    return getYear(academicYearId, { transaction, lock: true });
  }
  const start = startDate ? String(startDate).slice(0, 10) : null;
  const year = start
    ? await AcademicYear.findOne({
        where: { startDate: { [Op.lte]: start }, endDate: { [Op.gte]: start } },
        raw: true,
        transaction,
        ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
      })
    : null;
  if (!year && required) {
    throw new AppError("Choose the academic year for this term (add the year under Academic years first).", 400);
  }
  return year;
};

/**
 * A term must sit inside its year's dates, and its number must be unique in
 * that year ("Term 2" only once per year). Old duplicate terms are left as
 * they are; this only checks the term being saved.
 */
export const assertTermFitsYear = async (year, { term, startDate, endDate }, excludeTermId = null, { transaction = null } = {}) => {
  const start = String(startDate).slice(0, 10);
  const end = String(endDate).slice(0, 10);
  if (start < String(year.startDate) || end > String(year.endDate)) {
    throw new AppError(`The term's dates must be inside ${year.name} (${year.startDate} to ${year.endDate})`, 400);
  }
  if (term != null && String(term).trim() !== "") {
    const where = { academicYearId: year.academicYearId, term: String(term).trim() };
    if (excludeTermId != null) where.termId = { [Op.ne]: excludeTermId };
    const clash = await Term.findOne({ where, raw: true, transaction });
    if (clash) throw new AppError(`${year.name} already has Term ${String(term).trim()}`, 409);
  }
};
