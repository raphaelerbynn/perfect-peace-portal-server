import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AcademicYear, StaffAttendance, Teacher, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { round2 } from "../utils/money.js";
import { requireActiveTerm } from "./term.js";
import { termName } from "./academicYear.js";

// B9: staff attendance (ported from SchoolPro's staff attendance service).
//   - one mark per member of staff per day (UNIQUE teacher_id, date), upserted;
//   - removals delete a saved mark: no row = unmarked, never "present";
//   - marks only for a date inside the active term, and not in the future;
//   - % = (present + late) / days marked (unmarked days don't count).
// Staff = every Teacher row that isn't archived (teaching and non-teaching).

export const STAFF_STATUSES = ["PRESENT", "ABSENT", "LATE", "SICK", "ON_LEAVE", "PERMISSION"];
const ATTENDED = new Set(["PRESENT", "LATE"]);
const MAX_ROWS = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const STAFF_ATTRS = ["teacherId", "fName", "lName", "staffPosition", "category", "isDeleted"];

/** Pure: "2026-11-14" (strict, real calendar date) or a 400. */
export const toDate = (value, label = "Date") => {
  const s = String(value ?? "").trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new AppError(`${label} must be a valid date`, 400);
  }
  return s;
};

/** Today's date on the server's clock (Ghana = UTC, so local = UTC). */
export const localToday = (now = new Date()) =>
  new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const dateOf = (v) => (v == null ? null : String(v).slice(0, 10));
const cleanStatus = (s) => String(s ?? "").trim().toUpperCase();
export const staffName = (t) => [t?.fName, t?.lName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");

const toTeacherId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${what} has an invalid staff id`, 400);
  return n;
};

/**
 * Pure: validate and clean a save request. Returns { date, entries, removals }.
 * Removals that are also in entries are dropped (the entry wins); duplicate
 * removals are merged; the same person twice in entries is refused.
 */
export const normaliseSave = (body = {}) => {
  const date = toDate(body.date);
  const rawEntries = body.entries ?? [];
  const rawRemovals = body.removals ?? [];
  if (!Array.isArray(rawEntries) || !Array.isArray(rawRemovals)) {
    throw new AppError("entries and removals must be lists", 400);
  }
  if (rawEntries.length > MAX_ROWS || rawRemovals.length > MAX_ROWS) {
    throw new AppError(`At most ${MAX_ROWS} staff can be saved at once`, 400);
  }

  const seen = new Set();
  const entries = rawEntries.map((e, i) => {
    const teacherId = toTeacherId(e?.teacherId, `Row ${i + 1}`);
    if (seen.has(teacherId)) throw new AppError("The same member of staff is in the list twice", 400);
    seen.add(teacherId);
    const status = cleanStatus(e?.status);
    if (!STAFF_STATUSES.includes(status)) {
      throw new AppError("Status must be Present, Absent, Late, Sick, On leave or Permission", 400);
    }
    const timeRaw = e?.timeIn == null ? "" : String(e.timeIn).trim();
    const timeIn = timeRaw === "" ? null : timeRaw.slice(0, 5);
    if (timeIn != null && !TIME_RE.test(timeIn)) throw new AppError("Time in must be a time like 07:45", 400);
    const remarksRaw = e?.remarks == null ? "" : String(e.remarks).trim();
    if (remarksRaw.length > 300) throw new AppError("Remarks must be 300 characters or fewer", 400);
    return { teacherId, status, timeIn, remarks: remarksRaw || null };
  });

  const removals = [...new Set(rawRemovals.map((v) => toTeacherId(v, "A removal")))].filter((id) => !seen.has(id));
  if (!entries.length && !removals.length) {
    throw new AppError("Mark at least one member of staff, or remove a saved mark", 400);
  }
  return { date, entries, removals };
};

/** Pure: is `date` inside the term (inclusive)? */
export const dateInTerm = (date, term) =>
  Boolean(term?.startDate && term?.endDate && date >= dateOf(term.startDate) && date <= dateOf(term.endDate));

/** Pure: counts per status, days marked and % = (present + late) / marked (null when nothing is marked). */
export const summarise = (rows = []) => {
  const counts = Object.fromEntries(STAFF_STATUSES.map((s) => [s, 0]));
  let marked = 0;
  for (const r of rows) {
    const s = cleanStatus(r.status);
    if (!(s in counts)) continue;
    counts[s] += 1;
    marked += 1;
  }
  const attended = counts.PRESENT + counts.LATE;
  return { counts, marked, attended, percent: marked ? round2((attended / marked) * 100) : null };
};

const staffView = (t) => ({
  teacherId: t.teacherId,
  name: staffName(t),
  position: t.staffPosition ?? null,
  category: t.category ?? null,
  archived: Boolean(t.isDeleted),
});

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.teacherId - b.teacherId;

const recordView = (r) => ({
  staffAttendanceId: r.staffAttendanceId,
  teacherId: r.teacherId,
  termId: r.termId,
  date: dateOf(r.date),
  status: cleanStatus(r.status),
  timeIn: r.timeIn ?? null,
  remarks: r.remarks ?? null,
  markedBy: r.markedBy ?? null,
  updatedAt: r.updatedAt ?? null,
});

/** Active staff, plus any archived staff who have marks in `rows` (so old marks still show). */
const staffFor = async (rows, { transaction = null } = {}) => {
  const active = await Teacher.findAll({
    where: { isDeleted: { [Op.not]: true } },
    attributes: STAFF_ATTRS,
    raw: true,
    transaction,
  });
  const have = new Set(active.map((t) => t.teacherId));
  const extraIds = [...new Set(rows.map((r) => r.teacherId))].filter((id) => !have.has(id));
  const extra = extraIds.length
    ? await Teacher.findAll({ where: { teacherId: { [Op.in]: extraIds } }, attributes: STAFF_ATTRS, raw: true, transaction })
    : [];
  return [...active, ...extra.map((t) => ({ ...t, isDeleted: true }))].map(staffView).sort(byName);
};

const termView = (t) =>
  t ? { termId: t.termId, name: termName(t), startDate: dateOf(t.startDate), endDate: dateOf(t.endDate) } : null;

/**
 * The register for one day: every active member of staff with their saved mark
 * (or null = unmarked). `editable` says whether the day can be saved (inside
 * the open term and not in the future) and `reason` why not.
 */
export const getStaffDay = async (dateValue, { today = localToday() } = {}) => {
  const date = toDate(dateValue);
  const term = await Term.findOne({ where: { active: true }, raw: true });
  const rows = await StaffAttendance.findAll({ where: { date }, raw: true });
  const staff = await staffFor(rows);
  const byTeacher = new Map(rows.map((r) => [r.teacherId, recordView(r)]));

  let reason = null;
  if (!term) reason = "No term is open. Open a term in Settings first.";
  else if (!dateInTerm(date, term)) reason = "This date is outside the open term.";
  else if (date > today) reason = "You can't mark attendance for a future date.";

  return {
    date,
    term: termView(term),
    editable: reason == null,
    reason,
    staff: staff
      .map((s) => ({ ...s, record: byTeacher.get(s.teacherId) ?? null }))
      // Archived staff only appear when they have a mark that day (to remove it).
      .filter((s) => !s.archived || s.record),
  };
};

/**
 * Save one day's register in ONE transaction: upsert each entry on
 * (teacher, date) and delete the removals' marks. The date must be inside the
 * active term and not after today; every entry must be active staff.
 */
export const saveStaffDay = async (body, user, { today = localToday() } = {}) => {
  const { date, entries, removals } = normaliseSave(body);
  if (date > today) throw new AppError("You can't mark attendance for a future date", 400);
  const markedBy = user?.username ?? null;

  try {
    return await sequelize.transaction(async (transaction) => {
      const term = await requireActiveTerm({ transaction });
      if (!dateInTerm(date, term)) {
        throw new AppError(
          `The date must be inside the open term (${dateOf(term.startDate) ?? "?"} to ${dateOf(term.endDate) ?? "?"})`,
          400
        );
      }

      let saved = 0;
      if (entries.length) {
        const ids = entries.map((e) => e.teacherId);
        const staff = await Teacher.findAll({
          where: { teacherId: { [Op.in]: ids }, isDeleted: { [Op.not]: true } },
          attributes: ["teacherId"],
          raw: true,
          transaction,
        });
        const found = new Set(staff.map((t) => t.teacherId));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length) {
          throw new AppError(`Not active staff (reload the page): ${missing.join(", ")}`, 400);
        }

        const existing = await StaffAttendance.findAll({
          where: { date, teacherId: { [Op.in]: ids } },
          raw: true,
          transaction,
          ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        const have = new Map(existing.map((r) => [r.teacherId, r]));
        const now = new Date();
        // Sequential: queries on one transaction run one at a time.
        for (const e of entries) {
          const values = { status: e.status, timeIn: e.timeIn, remarks: e.remarks, markedBy, termId: term.termId, updatedAt: now };
          const row = have.get(e.teacherId);
          if (row) {
            await StaffAttendance.update(values, { where: { staffAttendanceId: row.staffAttendanceId }, transaction });
          } else {
            await StaffAttendance.create({ ...values, teacherId: e.teacherId, date, createdAt: now }, { transaction });
          }
          saved += 1;
        }
      }

      const removed = removals.length
        ? await StaffAttendance.destroy({ where: { date, teacherId: { [Op.in]: removals } }, transaction })
        : 0;

      return { date, termId: term.termId, saved, removed };
    });
  } catch (error) {
    // Two people saving the same new day at once: the unique index stops the
    // second one. Say so instead of a 500.
    if (error?.name === "SequelizeUniqueConstraintError") {
      throw new AppError("Someone else saved this day at the same time. Reload and try again.", 409);
    }
    throw error;
  }
};

/**
 * Pure-ish: which marks a summary covers. One of (first given wins):
 *   termId          marks filed under that term
 *   academicYearId  marks dated inside the year
 *   from + to       marks dated in the range (inclusive)
 *   nothing         the open term
 */
export const resolveRange = async (query = {}) => {
  const has = (v) => v != null && String(v).trim() !== "";
  if (has(query.termId)) {
    const id = Number(query.termId);
    const term = Number.isInteger(id) && id > 0 ? await Term.findOne({ where: { termId: id }, raw: true }) : null;
    if (!term) throw new AppError("Term not found", 404);
    return {
      kind: "term",
      label: termName(term),
      termId: term.termId,
      from: dateOf(term.startDate),
      to: dateOf(term.endDate),
      where: { termId: term.termId },
    };
  }
  if (has(query.academicYearId)) {
    const id = Number(query.academicYearId);
    const year = Number.isInteger(id) && id > 0 ? await AcademicYear.findOne({ where: { academicYearId: id }, raw: true }) : null;
    if (!year) throw new AppError("Academic year not found", 404);
    const from = dateOf(year.startDate);
    const to = dateOf(year.endDate);
    return { kind: "year", label: year.name, academicYearId: year.academicYearId, from, to, where: { date: { [Op.between]: [from, to] } } };
  }
  if (has(query.from) || has(query.to)) {
    if (!has(query.from) || !has(query.to)) throw new AppError("Give both a From and a To date", 400);
    const from = toDate(query.from, "From");
    const to = toDate(query.to, "To");
    if (from > to) throw new AppError("From must be on or before To", 400);
    return { kind: "range", label: `${from} to ${to}`, from, to, where: { date: { [Op.between]: [from, to] } } };
  }
  const term = await requireActiveTerm();
  return {
    kind: "term",
    label: termName(term),
    termId: term.termId,
    from: dateOf(term.startDate),
    to: dateOf(term.endDate),
    where: { termId: term.termId },
  };
};

const publicRange = ({ where, ...rest }) => rest;

/** Per-staff summary for a term / year / date range, plus school totals. */
export const getStaffSummary = async (query = {}) => {
  const range = await resolveRange(query);
  const rows = await StaffAttendance.findAll({ where: range.where, attributes: ["teacherId", "status"], raw: true });
  const staff = await staffFor(rows);
  const byTeacher = new Map();
  for (const r of rows) {
    if (!byTeacher.has(r.teacherId)) byTeacher.set(r.teacherId, []);
    byTeacher.get(r.teacherId).push(r);
  }
  return {
    range: publicRange(range),
    totals: { staff: staff.filter((s) => !s.archived).length, ...summarise(rows) },
    staff: staff.map((s) => ({ ...s, ...summarise(byTeacher.get(s.teacherId) ?? []) })),
  };
};

/** One member of staff: summary and each marked day (newest first). Archived staff too. */
export const getOneStaffSummary = async (teacherIdValue, query = {}) => {
  const teacherId = Number(teacherIdValue);
  const teacher =
    Number.isInteger(teacherId) && teacherId > 0
      ? await Teacher.findOne({ where: { teacherId }, attributes: STAFF_ATTRS, raw: true })
      : null;
  if (!teacher) throw new AppError("Staff member not found", 404);
  const range = await resolveRange(query);
  const rows = await StaffAttendance.findAll({
    where: { ...range.where, teacherId },
    order: [["date", "DESC"]],
    raw: true,
  });
  return {
    teacher: staffView(teacher),
    range: publicRange(range),
    ...summarise(rows),
    records: rows.map(recordView),
  };
};
