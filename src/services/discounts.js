import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AcademicYear, Class, DiscountType, Parent, Student, StudentDiscount, StudentTermBill, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { isPesewaAmount, round2, toNum } from "../utils/money.js";
import { recomputeStudentOwing } from "./fee.js";
import { discountCoversTerm } from "./feeBill.js";

// ---------------------------------------------------------------------------
// B12: discount types and the discounts pupils get.
//   - A type's kind / value / item can't change once pupils have it (that would
//     silently re-price balances): create a new type instead. Deactivating a
//     type stops NEW use; pupils who have it keep it until it is ended.
//   - Giving, ending or removing a pupil's discount changes their balance:
//     the pupil is locked and recomputed in the same transaction.
//   - Sibling discounts are SUGGESTED from linked parents; the office confirms.
// ---------------------------------------------------------------------------

export const KINDS = ["PERCENT", "FIXED"];
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const toId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${what} not found`, 404);
  return n;
};
const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

/** Pure: validates a discount type. Returns the clean values. */
export const validateDiscountType = (data = {}) => {
  const name = clean(data.name);
  if (name.length < 2 || name.length > 100) throw new AppError("The discount's name must be 2–100 characters", 400);
  const kind = String(data.kind ?? "").toUpperCase();
  if (!KINDS.includes(kind)) throw new AppError("Choose a percentage or a fixed amount", 400);
  const value = Number(data.value);
  if (data.value == null || data.value === "" || !Number.isFinite(value) || value <= 0) {
    throw new AppError("The discount must be more than 0", 400);
  }
  if (kind === "PERCENT" && value > 100) throw new AppError("A percentage discount can't be more than 100%", 400);
  if (!isPesewaAmount(value)) throw new AppError("Use at most 2 decimal places", 400);
  const appliesTo = clean(data.appliesTo) || null;
  if (appliesTo && appliesTo.length > 50) throw new AppError("The fee item name is too long", 400);
  const description = clean(data.description) || null;
  if (description && description.length > 500) throw new AppError("The description is too long (500 characters at most)", 400);
  return { name, kind, value: round2(value), appliesTo, description };
};

const assertNameFree = async (name, excludeId, transaction) => {
  const where = { name: { [Op.iLike]: name.replace(/[\\%_]/g, (c) => `\\${c}`) } };
  if (excludeId != null) where.discountTypeId = { [Op.ne]: excludeId };
  const clash = await DiscountType.findOne({ where, raw: true, transaction });
  if (clash) throw new AppError(`There is already a discount called ${clash.name}`, 409);
};

export const listDiscountTypes = async ({ includeInactive } = {}) => {
  const all = includeInactive === true || includeInactive === "true";
  const types = await DiscountType.findAll({ where: all ? {} : { isActive: true }, order: [["name", "ASC"]], raw: true });
  const used = await StudentDiscount.findAll({ attributes: ["discountTypeId"], raw: true });
  const counts = new Map();
  for (const u of used) counts.set(Number(u.discountTypeId), (counts.get(Number(u.discountTypeId)) || 0) + 1);
  return types.map((t) => ({ ...t, value: toNum(t.value), pupils: counts.get(Number(t.discountTypeId)) || 0 }));
};

export const createDiscountType = async (data, { createdBy = null } = {}) => {
  const v = validateDiscountType(data);
  return sequelize.transaction(async (transaction) => {
    await assertNameFree(v.name, null, transaction);
    const row = await DiscountType.create({ ...v, isActive: true, createdBy }, { transaction });
    return typeof row?.toJSON === "function" ? row.toJSON() : row;
  });
};

export const updateDiscountType = async (id, data = {}) =>
  sequelize.transaction(async (transaction) => {
    const type = await DiscountType.findOne({ where: { discountTypeId: toId(id, "Discount") }, raw: true, transaction, lock: transaction.LOCK?.UPDATE });
    if (!type) throw new AppError("Discount not found", 404);
    const v = validateDiscountType({
      name: data.name ?? type.name,
      kind: data.kind ?? type.kind,
      value: data.value ?? type.value,
      appliesTo: Object.prototype.hasOwnProperty.call(data, "appliesTo") ? data.appliesTo : type.appliesTo,
      description: Object.prototype.hasOwnProperty.call(data, "description") ? data.description : type.description,
    });
    const priceChanged =
      v.kind !== type.kind || round2(v.value) !== round2(type.value) || (v.appliesTo || "").toLowerCase() !== String(type.appliesTo || "").toLowerCase();
    if (priceChanged) {
      const inUse = await StudentDiscount.count({ where: { discountTypeId: type.discountTypeId }, transaction });
      if (inUse > 0) {
        throw new AppError(`${type.name} is given to ${inUse} pupil${inUse === 1 ? "" : "s"}, so its amount can't change. Add a new discount instead.`, 409);
      }
    }
    if (v.name.toLowerCase() !== String(type.name).toLowerCase()) await assertNameFree(v.name, type.discountTypeId, transaction);
    const patch = { ...v };
    if (data.isActive != null) patch.isActive = data.isActive === true || data.isActive === "true";
    await DiscountType.update(patch, { where: { discountTypeId: type.discountTypeId }, transaction });
    return { ...type, ...patch };
  });

export const deleteDiscountType = async (id) =>
  sequelize.transaction(async (transaction) => {
    const type = await DiscountType.findOne({ where: { discountTypeId: toId(id, "Discount") }, raw: true, transaction, lock: transaction.LOCK?.UPDATE });
    if (!type) throw new AppError("Discount not found", 404);
    const inUse = await StudentDiscount.count({ where: { discountTypeId: type.discountTypeId }, transaction });
    if (inUse > 0) throw new AppError(`${type.name} has been given to pupils. Switch it off instead.`, 409);
    await DiscountType.destroy({ where: { discountTypeId: type.discountTypeId }, transaction });
    return { deleted: true };
  });

// --- pupils' discounts -------------------------------------------------------------

const lockPupil = async (studentId, transaction) => {
  const pupil = await Student.findOne({
    where: { studentId: toId(studentId, "Student"), isDeleted: false },
    attributes: ["studentId", "fName", "mName", "lName", "feesPeriodTermId"],
    raw: true,
    transaction,
    lock: transaction.LOCK?.UPDATE,
  });
  if (!pupil) throw new AppError("Student not found", 404);
  return pupil;
};

const termsMap = async (ids, transaction) => {
  const list = [...new Set(ids.filter((x) => x != null).map(Number))];
  const rows = list.length ? await Term.findAll({ where: { termId: list }, attributes: ["termId", "term", "startDate", "academicYearId"], raw: true, transaction }) : [];
  return new Map(rows.map((t) => [Number(t.termId), t]));
};

const startKey = (t) => `${t?.startDate ? String(t.startDate).slice(0, 10) : "0000-00-00"}#${String(t?.termId ?? 0).padStart(10, "0")}`;

/** Pure: do two from/to ranges (to null = open-ended) overlap? */
export const rangesOverlap = (a, b, termsById) => {
  const aFrom = startKey(termsById.get(Number(a.fromTermId)));
  const bFrom = startKey(termsById.get(Number(b.fromTermId)));
  const aTo = a.toTermId == null ? "9999" : startKey(termsById.get(Number(a.toTermId)));
  const bTo = b.toTermId == null ? "9999" : startKey(termsById.get(Number(b.toTermId)));
  return aFrom <= bTo && bFrom <= aTo;
};

export const listStudentDiscounts = async (studentId) => {
  const rows = await StudentDiscount.findAll({ where: { studentId: toId(studentId, "Student") }, order: [["studentDiscountId", "ASC"]], raw: true });
  const types = rows.length ? await DiscountType.findAll({ where: { discountTypeId: [...new Set(rows.map((r) => r.discountTypeId))] }, raw: true }) : [];
  const byType = new Map(types.map((t) => [Number(t.discountTypeId), t]));
  const terms = await termsMap(rows.flatMap((r) => [r.fromTermId, r.toTermId]));
  // "Term 2 · 2026/2027" on screen: add the year's name.
  const yearIds = [...new Set([...terms.values()].map((t) => t.academicYearId).filter((x) => x != null))];
  const years = yearIds.length ? await AcademicYear.findAll({ where: { academicYearId: yearIds }, attributes: ["academicYearId", "name"], raw: true }) : [];
  const yearName = new Map(years.map((y) => [Number(y.academicYearId), y.name]));
  for (const t of terms.values()) t.academicYearName = yearName.get(Number(t.academicYearId)) ?? null;
  return rows.map((r) => {
    const t = byType.get(Number(r.discountTypeId));
    return {
      ...r,
      name: t?.name ?? null,
      kind: t?.kind ?? null,
      value: t ? toNum(t.value) : null,
      appliesTo: t?.appliesTo ?? null,
      fromTerm: terms.get(Number(r.fromTermId)) || null,
      toTerm: r.toTermId != null ? terms.get(Number(r.toTermId)) || null : null,
    };
  });
};

export const addStudentDiscount = async (data = {}, { createdBy = null } = {}) => {
  const source = String(data.source || "MANUAL").toUpperCase();
  if (!["MANUAL", "SIBLING"].includes(source)) throw new AppError("Unknown source", 400);
  const reason = clean(data.reason) || null;
  if (reason && reason.length > 300) throw new AppError("Keep the reason under 300 characters", 400);
  return sequelize.transaction(async (transaction) => {
    const pupil = await lockPupil(data.studentId, transaction);
    const type = await DiscountType.findOne({ where: { discountTypeId: toId(data.discountTypeId, "Discount") }, raw: true, transaction });
    if (!type) throw new AppError("Discount not found", 404);
    if (!type.isActive) throw new AppError(`${type.name} is switched off`, 400);

    let fromTermId = data.fromTermId;
    if (fromTermId == null || fromTermId === "") {
      const open = await Term.findOne({ where: { active: true }, attributes: ["termId"], raw: true, transaction });
      if (!open) throw new AppError("Choose the term the discount starts from (no term is open)", 400);
      fromTermId = open.termId;
    }
    const toTermId = data.toTermId == null || data.toTermId === "" ? null : toId(data.toTermId, "Term");
    fromTermId = toId(fromTermId, "Term");
    const existing = await StudentDiscount.findAll({ where: { studentId: pupil.studentId, discountTypeId: type.discountTypeId }, raw: true, transaction });
    const terms = await termsMap([fromTermId, toTermId, ...existing.flatMap((e) => [e.fromTermId, e.toTermId])], transaction);
    if (!terms.has(fromTermId)) throw new AppError("Term not found", 404);
    if (toTermId != null && !terms.has(toTermId)) throw new AppError("Term not found", 404);
    if (toTermId != null && startKey(terms.get(toTermId)) < startKey(terms.get(fromTermId))) {
      throw new AppError("The last term can't be before the first term", 400);
    }
    const mine = { fromTermId, toTermId };
    if (existing.some((e) => rangesOverlap(e, mine, terms))) {
      throw new AppError(`${fullName(pupil)} already has ${type.name} for some of these terms`, 409);
    }

    const row = await StudentDiscount.create(
      { studentId: pupil.studentId, discountTypeId: type.discountTypeId, fromTermId, toTermId, source, reason, createdBy },
      { transaction }
    );
    const now = await recomputeStudentOwing(pupil.studentId, { transaction });
    const out = typeof row?.toJSON === "function" ? row.toJSON() : row;
    return { ...out, owing: now?.owing ?? null };
  });
};

/**
 * The pupil's billed terms this discount covers, other than the current one:
 * those bills are history, so the discount can be ended but not removed.
 */
const coveredPastBills = async (row, pupil, transaction) => {
  const bills = await StudentTermBill.findAll({ where: { studentId: row.studentId }, attributes: ["termId"], raw: true, transaction });
  const terms = await termsMap([row.fromTermId, row.toTermId, ...bills.map((b) => b.termId)], transaction);
  return bills.filter(
    (b) => Number(b.termId) !== Number(pupil.feesPeriodTermId) && discountCoversTerm(row, terms.get(Number(b.termId)), terms)
  );
};

/** End a pupil's discount after `toTermId` (it stops applying to later terms). */
export const endStudentDiscount = async (id, { toTermId } = {}) =>
  sequelize.transaction(async (transaction) => {
    const sid = toId(id, "Discount");
    const peek = await StudentDiscount.findOne({ where: { studentDiscountId: sid }, raw: true, transaction });
    if (!peek) throw new AppError("Discount not found", 404);
    const pupil = await lockPupil(peek.studentId, transaction);
    const row = await StudentDiscount.findOne({ where: { studentDiscountId: sid }, raw: true, transaction });
    if (!row) throw new AppError("Discount not found", 404);
    const to = toId(toTermId, "Term");
    // Moving the end later could run into another row of the same discount:
    // the same overlap check as giving it (else it would apply twice).
    const others = (
      await StudentDiscount.findAll({ where: { studentId: row.studentId, discountTypeId: row.discountTypeId }, raw: true, transaction })
    ).filter((o) => Number(o.studentDiscountId) !== sid);
    const terms = await termsMap([row.fromTermId, to, ...others.flatMap((o) => [o.fromTermId, o.toTermId])], transaction);
    if (!terms.has(to)) throw new AppError("Term not found", 404);
    if (startKey(terms.get(to)) < startKey(terms.get(Number(row.fromTermId)))) {
      throw new AppError("The last term can't be before the first term. Remove the discount instead.", 400);
    }
    const mine = { fromTermId: row.fromTermId, toTermId: to };
    if (others.some((o) => rangesOverlap(o, mine, terms))) {
      const type = await DiscountType.findOne({ where: { discountTypeId: row.discountTypeId }, attributes: ["name"], raw: true, transaction });
      throw new AppError(`${fullName(pupil)} already has ${type?.name ?? "this discount"} for some of these terms`, 409);
    }
    await StudentDiscount.update({ toTermId: to }, { where: { studentDiscountId: sid }, transaction });
    const now = await recomputeStudentOwing(row.studentId, { transaction });
    return { ...row, toTermId: to, owing: now?.owing ?? null };
  });

/** Remove a discount given by mistake. Refused once it has been on a past term's bill (end it instead). */
export const removeStudentDiscount = async (id) =>
  sequelize.transaction(async (transaction) => {
    const sid = toId(id, "Discount");
    const peek = await StudentDiscount.findOne({ where: { studentDiscountId: sid }, raw: true, transaction });
    if (!peek) throw new AppError("Discount not found", 404);
    const pupil = await lockPupil(peek.studentId, transaction);
    const row = await StudentDiscount.findOne({ where: { studentDiscountId: sid }, raw: true, transaction });
    if (!row) throw new AppError("Discount not found", 404);
    const past = await coveredPastBills(row, pupil, transaction);
    if (past.length) {
      throw new AppError("This discount is on bills for earlier terms, so it can't be removed. End it instead.", 409);
    }
    await StudentDiscount.destroy({ where: { studentDiscountId: sid }, transaction });
    const now = await recomputeStudentOwing(row.studentId, { transaction });
    return { deleted: true, owing: now?.owing ?? null };
  });

// --- sibling suggestions -------------------------------------------------------------

/** Ghana numbers in any format -> the last 9 digits ("024 412 3456", "+233244123456" -> "244123456"). */
export const phoneKey = (v) => {
  const digits = String(v ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
};

/**
 * Pure. Groups pupils into families: the same parent record, or parents with
 * the same phone number. Families of 2+ pupils; eldest first (date of birth,
 * then admission number). The eldest pays in full; the 2nd child onward is
 * suggested for a sibling discount (default; the office confirms each).
 */
export const groupSiblings = (pupils, parents) => {
  const parentById = new Map(parents.map((p) => [Number(p.parentId), p]));
  // union-find on "p<parentId>" and "t<phone>"
  const up = new Map();
  const find = (x) => {
    while (up.get(x) !== x) {
      up.set(x, up.get(up.get(x)));
      x = up.get(x);
    }
    return x;
  };
  const add = (x) => {
    if (!up.has(x)) up.set(x, x);
  };
  const join = (a, b) => {
    add(a);
    add(b);
    up.set(find(a), find(b));
  };
  for (const p of parents) {
    const k = `p${p.parentId}`;
    add(k);
    for (const phone of [phoneKey(p.contact), phoneKey(p.contact1)]) if (phone) join(k, `t${phone}`);
  }
  const families = new Map();
  for (const s of pupils) {
    if (s.parentId == null || !parentById.has(Number(s.parentId))) continue;
    const root = find(`p${s.parentId}`);
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(s);
  }
  const out = [];
  for (const [key, kids] of families) {
    if (kids.length < 2) continue;
    kids.sort((a, b) => {
      const da = a.dob ? String(a.dob).slice(0, 10) : "9999";
      const db = b.dob ? String(b.dob).slice(0, 10) : "9999";
      return da.localeCompare(db) || Number(a.studentId) - Number(b.studentId);
    });
    const guardian = parentById.get(Number(kids[0].parentId));
    out.push({ key, guardian, children: kids, suggestedStudentIds: kids.slice(1).map((k) => k.studentId) });
  }
  return out.sort((a, b) => b.children.length - a.children.length || String(a.key).localeCompare(String(b.key)));
};

export const siblingSuggestions = async () => {
  const alumni = await Class.findAll({ where: { isAlumni: true }, attributes: ["classId"], raw: true });
  const alumniIds = new Set(alumni.map((c) => Number(c.classId)));
  const pupils = (
    await Student.findAll({
      where: { isDeleted: false, parentId: { [Op.ne]: null } },
      attributes: ["studentId", "fName", "mName", "lName", "classId", "class", "dob", "parentId"],
      raw: true,
    })
  ).filter((s) => s.classId == null || !alumniIds.has(Number(s.classId)));
  const parentIds = [...new Set(pupils.map((s) => Number(s.parentId)))];
  const parents = parentIds.length
    ? await Parent.findAll({ where: { parentId: parentIds }, attributes: ["parentId", "fName", "lName", "contact", "contact1"], raw: true })
    : [];
  const families = groupSiblings(pupils, parents);
  const ids = families.flatMap((f) => f.children.map((c) => c.studentId));
  const given = ids.length ? await StudentDiscount.findAll({ where: { studentId: ids }, raw: true }) : [];
  const types = given.length ? await DiscountType.findAll({ where: { discountTypeId: [...new Set(given.map((g) => g.discountTypeId))] }, raw: true }) : [];
  const open = await Term.findOne({ where: { active: true }, attributes: ["termId", "startDate"], raw: true });
  const terms = await termsMap([open?.termId, ...given.flatMap((g) => [g.fromTermId, g.toTermId])]);
  const typeName = new Map(types.map((t) => [Number(t.discountTypeId), t.name]));
  return families.map((f) => ({
    key: f.key,
    guardian: f.guardian ? { name: [f.guardian.fName, f.guardian.lName].filter(Boolean).join(" "), contact: f.guardian.contact } : null,
    children: f.children.map((c) => {
      const current = given.filter(
        (g) => Number(g.studentId) === Number(c.studentId) && (!open || discountCoversTerm(g, terms.get(Number(open.termId)), terms))
      );
      return {
        studentId: c.studentId,
        name: fullName(c),
        className: c.class ? String(c.class).trim() : null,
        dob: c.dob ?? null,
        discounts: current.map((g) => typeName.get(Number(g.discountTypeId))).filter(Boolean),
        hasSiblingDiscount: current.some((g) => g.source === "SIBLING"),
      };
    }),
    suggestedStudentIds: f.suggestedStudentIds,
  }));
};
