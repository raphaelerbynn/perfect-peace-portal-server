import { Op } from "sequelize";
import sequelize from "../config/database.js";
import {
  Class,
  KgAssessment,
  PromotionRule,
  Student,
  StudentPromotion,
  StudentResult,
  Term,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { isKgSection } from "./teacherScope.js";
import { assertClassAccess } from "./attendance.js";
import { hasPermission, P } from "../utils/permissions.js";
import { recomputeStudentOwing, startFeePeriod } from "./fee.js";

// ---------------------------------------------------------------------------
// B5: promotion. Ported from SchoolPro's PromotionService
// (grades/promotion.service.ts):
//   preview (read only) -> the office changes outcomes with a reason ->
//   accept (recomputed server-side, one transaction, history row per pupil;
//   accepting again updates the row instead of moving the pupil twice).
//
// PP specifics:
//   - The class ladder is Class.next_class_id. A next class flagged
//     is_alumni means "graduates" (pupils move into the alumni class, as the
//     school does today with its graduated classes).
//   - Average = the pupil's term result: raw score / total raw score * 100.
//   - KG has no average: pupils move up unless the teacher's "promoted to"
//     names their own class (client question B5.3).
//   - The teacher's "promoted to" from term-3 entry is shown as a
//     recommendation, not acted on.
//   - Fees: a pupil's FIRST decision for the term starts a new fee period
//     (services/fee.js startFeePeriod): what is still owed carries over as
//     arrears and the new class's bill is added; "paid" restarts. Changing the
//     decision later just swaps the class bill (no second new year).
// ---------------------------------------------------------------------------

export const OUTCOMES = ["PROMOTED", "REPEATED", "GRADUATED"];
/** Used when the school hasn't set a pass mark: "Fail" is below 40 in the grade bands. */
export const DEFAULT_PASS_MARK = 40;
export const REASON_MIN = 3;

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const round1 = (n) => Math.round(n * 10) / 10;

// --- class ladder -------------------------------------------------------------

/**
 * Pure: checks a whole ladder. `classes` = [{ classId, name, nextClassId, isAlumni }].
 * Throws 400 for a class pointing at itself, at a missing class, an alumni
 * class with a next class, or a loop (names the loop).
 */
export const validateLadder = (classes) => {
  const byId = new Map(classes.map((c) => [Number(c.classId), c]));
  for (const c of classes) {
    if (c.nextClassId == null) continue;
    const next = byId.get(Number(c.nextClassId));
    if (Number(c.nextClassId) === Number(c.classId)) throw new AppError(`${c.name} can't move up into itself`, 400);
    if (!next) throw new AppError(`${c.name}'s next class doesn't exist (or was removed)`, 400);
    if (c.isAlumni) throw new AppError(`${c.name} is an alumni class, so it can't have a next class`, 400);
  }
  for (const start of classes) {
    const seen = [];
    let cur = start;
    while (cur && cur.nextClassId != null) {
      if (seen.includes(Number(cur.classId))) {
        const loop = seen.slice(seen.indexOf(Number(cur.classId))).map((id) => byId.get(id).name);
        throw new AppError(`The class order goes round in a circle: ${[...loop, loop[0]].join(" → ")}`, 400);
      }
      seen.push(Number(cur.classId));
      cur = byId.get(Number(cur.nextClassId));
    }
  }
  return true;
};

export const getLadder = async () => {
  const classes = await Class.findAll({
    where: { isDeleted: { [Op.not]: true } },
    attributes: ["classId", "name", "section", "nextClassId", "isAlumni"],
    raw: true,
  });
  return classes
    .map((c) => ({ ...c, classId: Number(c.classId), nextClassId: c.nextClassId == null ? null : Number(c.nextClassId), isAlumni: Boolean(c.isAlumni) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
};

/** Save the next class / alumni flag of many classes at once (checked as a whole). */
export const saveLadder = async (changes) => {
  if (!Array.isArray(changes)) throw new AppError("classes must be a list", 400);
  return sequelize.transaction(async (transaction) => {
    const current = await Class.findAll({
      where: { isDeleted: { [Op.not]: true } },
      attributes: ["classId", "name", "nextClassId", "isAlumni"],
      raw: true,
      transaction,
    });
    const byId = new Map(current.map((c) => [Number(c.classId), { ...c, classId: Number(c.classId) }]));
    for (const ch of changes) {
      const c = byId.get(Number(ch.classId));
      if (!c) throw new AppError("Class not found", 404);
      if (ch.nextClassId !== undefined) c.nextClassId = ch.nextClassId === null || ch.nextClassId === "" ? null : Number(ch.nextClassId);
      if (ch.isAlumni !== undefined) c.isAlumni = Boolean(ch.isAlumni);
    }
    validateLadder([...byId.values()]);
    for (const ch of changes) {
      const c = byId.get(Number(ch.classId));
      await Class.update({ nextClassId: c.nextClassId, isAlumni: c.isAlumni }, { where: { classId: c.classId }, transaction });
    }
    return { saved: changes.length };
  });
};

// --- pass marks ---------------------------------------------------------------

export const getRules = async () => {
  const rows = await PromotionRule.findAll({ raw: true });
  const school = rows.find((r) => r.classId == null);
  return {
    defaultPassMark: school ? Number(school.passMark) : null,
    fallbackPassMark: DEFAULT_PASS_MARK,
    classRules: rows.filter((r) => r.classId != null).map((r) => ({ classId: Number(r.classId), passMark: Number(r.passMark) })),
  };
};

const checkMark = (v, what) => {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new AppError(`${what} must be a number from 0 to 100`, 400);
  }
  return Math.round(n * 100) / 100;
};

/** Replace all pass marks: { defaultPassMark, classRules: [{ classId, passMark }] }. */
export const saveRules = async ({ defaultPassMark, classRules = [] } = {}, { updatedBy = null } = {}) => {
  const school = checkMark(defaultPassMark, "The school pass mark");
  if (!Array.isArray(classRules)) throw new AppError("classRules must be a list", 400);
  const seen = new Set();
  const rows = classRules.map((r) => {
    const classId = toInt(r.classId, "classId");
    if (seen.has(classId)) throw new AppError("A class has two pass marks", 400);
    seen.add(classId);
    return { classId, passMark: checkMark(r.passMark, "A class pass mark") };
  });
  await sequelize.transaction(async (transaction) => {
    if (rows.length) {
      const found = await Class.findAll({ where: { classId: { [Op.in]: rows.map((r) => r.classId) } }, attributes: ["classId"], raw: true, transaction });
      if (found.length !== rows.length) throw new AppError("Class not found", 404);
    }
    await PromotionRule.destroy({ where: {}, transaction });
    await PromotionRule.bulkCreate(
      [{ classId: null, passMark: school, updatedBy }, ...rows.map((r) => ({ ...r, updatedBy }))],
      { transaction }
    );
  });
  return getRules();
};

/** Class rule beats the school default; the built-in fallback beats nothing. */
export const resolvePassMark = (rules, classId) => {
  const own = rules.classRules.find((r) => r.classId === Number(classId));
  if (own) return { passMark: own.passMark, source: "class" };
  if (rules.defaultPassMark != null) return { passMark: rules.defaultPassMark, source: "school" };
  return { passMark: DEFAULT_PASS_MARK, source: "fallback" };
};

// --- preview --------------------------------------------------------------------

/**
 * Pure: one pupil's row. `ctx` = { klass, nextClass, kg, passMark }.
 * Returns the computed outcome, the proposed one (a kept override wins),
 * destination and flags.
 */
export const decide = (pupil, ctx, { resetOverrides = false } = {}) => {
  const { klass, nextClass, kg, passMark } = ctx;
  const existing = pupil.existing || null;
  const recommendation = pupil.recommendation ? String(pupil.recommendation).trim() : null;

  let average = null;
  let computed = null;
  const hasResult = Boolean(pupil.hasResult);
  if (hasResult && !kg) {
    const total = Number(pupil.totalRawScore);
    average = total > 0 ? round1((Number(pupil.rawScore) / total) * 100) : null;
  }
  const moveUp = nextClass ? (nextClass.isAlumni ? "GRADUATED" : "PROMOTED") : "PROMOTED";
  if (hasResult) {
    if (kg) {
      // KG: move up unless the teacher kept them in their own class.
      computed = recommendation && norm(recommendation) === norm(klass.name) ? "REPEATED" : moveUp;
    } else {
      computed = average != null && average >= passMark ? moveUp : "REPEATED";
    }
  }

  const keepOverride = Boolean(existing?.overridden) && !resetOverrides;
  // No result = no outcome: the safe default is to stay put and flag it.
  const outcome = keepOverride ? existing.outcome : computed ?? "REPEATED";

  const flags = [];
  if (!hasResult) flags.push("NO_RESULT");
  if (keepOverride) flags.push("OVERRIDDEN");
  if (existing) flags.push("ALREADY_ACCEPTED");
  if (outcome !== "REPEATED" && !nextClass) flags.push("NO_NEXT_CLASS");
  if (recommendation) {
    // Without a next class we can only judge "keep them in this class".
    const keepsBack = norm(recommendation) === norm(klass.name);
    const says = keepsBack ? "REPEATED" : !nextClass ? null : norm(recommendation) === norm(nextClass.name) ? moveUp : "OTHER";
    if (says && says !== outcome) flags.push("TEACHER_DISAGREES");
  }

  const fromClassId = existing?.fromClassId ?? klass.classId;
  const fromClassName = existing?.fromClassName ?? klass.name;
  // Repeating = stay in the class as it is called NOW (it may have been renamed
  // since the decision was first recorded).
  const to =
    outcome === "REPEATED"
      ? { toClassId: fromClassId, toClassName: Number(fromClassId) === Number(klass.classId) ? klass.name : fromClassName }
      : { toClassId: nextClass?.classId ?? null, toClassName: nextClass?.name ?? null };

  return {
    studentId: pupil.studentId,
    name: pupil.name,
    hasResult,
    average,
    recommendation,
    computed,
    outcome,
    overridden: keepOverride,
    reason: keepOverride ? existing.reason : null,
    fromClassId: Number(fromClassId),
    fromClassName,
    ...to,
    alreadyAccepted: Boolean(existing),
    acceptedOutcome: existing?.outcome ?? null,
    flags,
  };
};

const loadClassAndTerm = async (classId, termId, transaction) => {
  const klass = await Class.findOne({ where: { classId: toInt(classId, "classId") }, raw: true, transaction });
  if (!klass) throw new AppError("Class not found", 404);
  const term = await Term.findOne({ where: { termId: toInt(termId, "termId") }, raw: true, transaction });
  if (!term) throw new AppError("Term not found", 404);
  const nextClass = klass.nextClassId
    ? await Class.findOne({ where: { classId: klass.nextClassId }, raw: true, transaction })
    : null;
  return { klass: { ...klass, classId: Number(klass.classId) }, term, nextClass: nextClass ? { ...nextClass, classId: Number(nextClass.classId), isAlumni: Boolean(nextClass.isAlumni) } : null };
};

export const getPreview = async ({ classId, termId, resetOverrides } = {}, { transaction = null } = {}) => {
  const { klass, term, nextClass } = await loadClassAndTerm(classId, termId, transaction);
  const kg = isKgSection(klass.section);
  const rules = await getRules();
  const { passMark, source } = resolvePassMark(rules, klass.classId);
  const where = { class: klass.name, termId: term.termId };

  const results = kg ? [] : await StudentResult.findAll({ where, raw: true, transaction });
  const kgRows = kg ? await KgAssessment.findAll({ where, attributes: ["studentId", "promoted"], raw: true, transaction }) : [];
  // Every decision this term: ours (frozen "from" side), and others' (pupils
  // promoted INTO this class from below are already decided and must not be
  // decided again here, or a second accept would move them back).
  const termHistory = await StudentPromotion.findAll({ where: { termId: term.termId }, raw: true, transaction });
  const history = termHistory.filter((h) => Number(h.fromClassId) === klass.classId);
  const decidedElsewhere = new Set(termHistory.filter((h) => Number(h.fromClassId) !== klass.classId).map((h) => Number(h.studentId)));

  // Who: pupils in the class now, anyone with results there that term, and
  // anyone already moved out of it by an accepted decision.
  const current = await Student.findAll({
    where: { isDeleted: false, [Op.or]: [{ classId: klass.classId }, { classId: null, class: klass.name }] },
    attributes: ["studentId", "fName", "mName", "lName"],
    raw: true,
    transaction,
  });
  const ids = new Set(current.map((s) => Number(s.studentId)));
  const others = [...results, ...kgRows, ...history].map((r) => Number(r.studentId)).filter((id) => !ids.has(id));
  const extra = others.length
    ? await Student.findAll({
        where: { studentId: { [Op.in]: [...new Set(others)] }, isDeleted: false },
        attributes: ["studentId", "fName", "mName", "lName"],
        raw: true,
        transaction,
      })
    : [];

  const resultOf = new Map(results.map((r) => [Number(r.studentId), r]));
  const kgOf = new Map();
  for (const r of kgRows) {
    const id = Number(r.studentId);
    const prev = kgOf.get(id) || { has: true, promoted: null };
    kgOf.set(id, { has: true, promoted: prev.promoted || r.promoted || null });
  }
  const historyOf = new Map(history.map((h) => [Number(h.studentId), { ...h, average: h.average == null ? null : Number(h.average) }]));

  const ctx = { klass, nextClass, kg, passMark };
  const rows = [...current, ...extra]
    .filter((s) => !decidedElsewhere.has(Number(s.studentId)))
    .map((s) => {
      const id = Number(s.studentId);
      const r = resultOf.get(id);
      const k = kgOf.get(id);
      return decide(
        {
          studentId: id,
          name: fullName(s),
          hasResult: kg ? Boolean(k) : Boolean(r),
          rawScore: r?.rawScore,
          totalRawScore: r?.totalRawScore,
          recommendation: kg ? k?.promoted : r?.promotedTo,
          existing: historyOf.get(id),
        },
        ctx,
        { resetOverrides: resetOverrides === true || resetOverrides === "true" }
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const count = (fn) => rows.filter(fn).length;
  const summary = {
    total: rows.length,
    promoted: count((r) => r.outcome === "PROMOTED"),
    repeated: count((r) => r.outcome === "REPEATED"),
    graduated: count((r) => r.outcome === "GRADUATED"),
    noResult: count((r) => r.flags.includes("NO_RESULT")),
    teacherDisagrees: count((r) => r.flags.includes("TEACHER_DISAGREES")),
    overridden: count((r) => r.overridden),
    accepted: count((r) => r.alreadyAccepted),
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const warnings = [];
  if (!nextClass) {
    warnings.push({
      code: "NO_NEXT_CLASS",
      message: `${klass.name} has no next class set, so nobody can move up yet. Set it under Class order.`,
    });
  }
  if (term.promotedByOldSystem) {
    warnings.push({
      code: "PROMOTED_BY_OLD_SYSTEM",
      message: "The old system already moved pupils up on these results, before the new system started. Nothing to accept here.",
    });
  } else if (String(term.term) !== "3") {
    warnings.push({ code: "NOT_TERM_3", message: `These are Term ${term.term} results. Pupils can only be moved on Term 3 results.` });
  } else if (term.active) {
    warnings.push({ code: "TERM_OPEN", message: "Term 3 is still open. Review now; you can accept once the term is closed, so registers, scores and report cards finish in this class." });
  }
  if (summary.noResult) {
    warnings.push({
      code: "NO_RESULT",
      message: `${plural(summary.noResult, "pupil has", "pupils have")} no ${kg ? "assessment" : "result"} this term. They stay in ${klass.name} unless you change it.`,
    });
  }
  if (summary.teacherDisagrees) {
    warnings.push({
      code: "TEACHER_DISAGREES",
      message: `For ${plural(summary.teacherDisagrees, "pupil", "pupils")}, the class teacher's "promoted to" differs from the outcome below. Check before accepting.`,
    });
  }
  if (summary.accepted) {
    warnings.push({
      code: "ALREADY_ACCEPTED",
      message: `${plural(summary.accepted, "pupil already has", "pupils already have")} a decision for this term. Accepting again updates it; nobody moves twice.`,
    });
  }

  return {
    class: { classId: klass.classId, name: klass.name, section: klass.section, isKg: kg },
    term: { termId: term.termId, term: term.term, startDate: term.startDate, endDate: term.endDate, active: Boolean(term.active), promotedByOldSystem: Boolean(term.promotedByOldSystem) },
    nextClass: nextClass ? { classId: nextClass.classId, name: nextClass.name, isAlumni: nextClass.isAlumni } : null,
    passMark: kg ? null : passMark,
    passMarkSource: kg ? null : source,
    summary,
    warnings,
    rows,
  };
};

// --- accept -----------------------------------------------------------------------

/**
 * Pupils move only on Term 3 results, and only once Term 3 is closed:
 *  - accepting earlier results would let a later Term 3 accept move a pupil twice;
 *  - while the term is open, a moved pupil would leave their class's register,
 *    score sheets and report cards before the term's results are finished.
 * The preview is available any time.
 */
export const assertCanAccept = (term) => {
  if (term.promotedByOldSystem) {
    throw new AppError("The old system already moved pupils up on this Term 3, before the new system started. Accepting again would move and bill them twice.", 409);
  }
  if (String(term.term) !== "3") {
    throw new AppError(`Promotion uses Term 3 results (the end of the year). Pick Term 3, not Term ${term.term}.`, 400);
  }
  if (term.active) {
    throw new AppError("Close Term 3 first (Term details on the dashboard), then accept. You can review the outcomes now.", 409);
  }
};

/**
 * Pure: turns the office's decisions into planned writes, checked against a
 * fresh preview (a stale or tampered payload can't send a pupil anywhere the
 * ladder doesn't allow).
 */
export const planAccept = (preview, decisions) => {
  if (!Array.isArray(decisions) || decisions.length === 0) throw new AppError("Send at least one decision", 400);
  const seen = new Set();
  const rowOf = new Map(preview.rows.map((r) => [r.studentId, r]));
  return decisions.map((d) => {
    const studentId = Number(d.studentId);
    if (seen.has(studentId)) throw new AppError("The same pupil appears twice", 400);
    seen.add(studentId);
    const row = rowOf.get(studentId);
    if (!row) throw new AppError("A pupil is no longer part of this class and term. Reload and try again.", 400);
    const outcome = String(d.outcome || "").toUpperCase();
    if (!OUTCOMES.includes(outcome)) throw new AppError(`Pick promote, repeat or graduate for ${row.name}`, 400);

    const nextIsAlumni = Boolean(preview.nextClass?.isAlumni);
    if (outcome !== "REPEATED") {
      if (!preview.nextClass) {
        throw new AppError(`${preview.class.name} has no next class set, so ${row.name} can't move up. Set the class order first.`, 400);
      }
      if (outcome === "GRADUATED" && !nextIsAlumni) {
        throw new AppError(`${row.name} can't graduate from ${preview.class.name}: its next class (${preview.nextClass.name}) isn't an alumni class`, 400);
      }
      if (outcome === "PROMOTED" && nextIsAlumni) {
        throw new AppError(`${preview.class.name} is the last class: ${row.name} graduates rather than moving up`, 400);
      }
    }
    // Measured against the computed outcome (no result = repeat by default).
    const overridden = outcome !== (row.computed ?? "REPEATED");
    const reason = String(d.reason ?? "").trim();
    if (overridden && reason.length < REASON_MIN) throw new AppError(`Give a reason for changing the outcome for ${row.name}`, 400);
    if (reason.length > 300) throw new AppError("Keep the reason under 300 characters", 400);

    const to =
      outcome === "REPEATED"
        ? { toClassId: row.fromClassId, toClassName: row.fromClassName }
        : { toClassId: preview.nextClass.classId, toClassName: preview.nextClass.name };
    return { studentId, outcome, overridden, reason: overridden ? reason : reason || null, row, ...to };
  });
};

export const acceptPromotion = async ({ classId, termId, decisions } = {}, { decidedBy = null } = {}) =>
  sequelize.transaction(async (transaction) => {
    // Lock the class so two people accepting at once can't interleave.
    await Class.findOne({ where: { classId: toInt(classId, "classId") }, attributes: ["classId"], transaction, lock: transaction.LOCK?.UPDATE });
    const preview = await getPreview({ classId, termId }, { transaction });
    assertCanAccept(preview.term);
    const planned = planAccept(preview, decisions);
    let moved = 0;
    let recorded = 0;
    let unchanged = 0;
    for (const p of planned) {
      const snapshot = {
        outcome: p.outcome,
        average: p.row.average,
        passMark: preview.passMark,
        fromClassId: p.row.fromClassId,
        fromClassName: p.row.fromClassName,
        toClassId: p.toClassId,
        toClassName: p.toClassName,
        teacherRecommendation: p.row.recommendation ? p.row.recommendation.slice(0, 50) : null,
        overridden: p.overridden,
        reason: p.reason,
        decidedBy,
        decidedAt: new Date(),
      };
      const existing = await StudentPromotion.findOne({ where: { studentId: p.studentId, termId: preview.term.termId }, raw: true, transaction });
      const same =
        existing &&
        existing.outcome === p.outcome &&
        Number(existing.toClassId) === Number(p.toClassId) &&
        (existing.reason ?? null) === (p.reason ?? null);
      if (same) {
        unchanged += 1;
      } else if (existing) {
        await StudentPromotion.update(snapshot, { where: { studentPromotionId: existing.studentPromotionId }, transaction });
        recorded += 1;
      } else {
        await StudentPromotion.create({ studentId: p.studentId, termId: preview.term.termId, ...snapshot }, { transaction });
        recorded += 1;
      }
      // First decision for this term = a new school year for the pupil's fees.
      // (B12: not when the pupil was already billed for a later term.)
      if (!existing) await startFeePeriod(p.studentId, { transaction, unlessBilledAfter: preview.term.startDate });
      // Put the pupil in the destination class (repeat = back in the class they
      // were promoted from, if an earlier accept had moved them).
      const [count] = await Student.update(
        { classId: p.toClassId, class: p.toClassName },
        // Legacy pupils may have classId NULL (matched by class name): in SQL
        // "class_id <> x" is not true for NULL, so include them explicitly.
        { where: { studentId: p.studentId, [Op.or]: [{ classId: { [Op.ne]: p.toClassId } }, { classId: null }] }, transaction }
      );
      moved += count;
      // Bill for the class they are now in (alumni classes have no fees, so a
      // graduate owes just their arrears).
      if (!same) await recomputeStudentOwing(p.studentId, { transaction });
    }
    const by = (o) => planned.filter((p) => p.outcome === o).length;
    return {
      moved,
      recorded,
      unchanged,
      promoted: by("PROMOTED"),
      repeated: by("REPEATED"),
      graduated: by("GRADUATED"),
    };
  });

// --- status / history --------------------------------------------------------------

/** Per class: pupils still waiting for a decision in this term (for the term-close warning). */
export const getStatus = async ({ termId } = {}) => {
  const term = await Term.findOne({ where: { termId: toInt(termId, "termId") }, raw: true });
  if (!term) throw new AppError("Term not found", 404);
  const classes = await getLadder();
  const pupils = await Student.findAll({ where: { isDeleted: false }, attributes: ["studentId", "classId", "class"], raw: true });
  const decided = await StudentPromotion.findAll({ where: { termId: term.termId }, attributes: ["studentId", "fromClassId"], raw: true });
  const decidedIds = new Set(decided.map((d) => Number(d.studentId)));
  // A class's pupils = those decided from it + those still in it undecided
  // (pupils promoted in from below belong to the class they were decided in).
  const rows = classes
    .filter((c) => !c.isAlumni)
    .map((c) => {
      const inClass = (p) => (p.classId == null ? norm(p.class) === norm(c.name) : Number(p.classId) === c.classId);
      const pending = pupils.filter((p) => inClass(p) && !decidedIds.has(Number(p.studentId))).length;
      const done = decided.filter((d) => Number(d.fromClassId) === c.classId).length;
      return { classId: c.classId, name: c.name, nextClassId: c.nextClassId, pupils: pending + done, decided: done, pending };
    });
  if (term.promotedByOldSystem) {
    // Already done by the old system: nothing is waiting for a decision.
    const done = rows.map((r) => ({ ...r, pending: 0 }));
    return { term: { termId: term.termId, term: term.term, promotedByOldSystem: true }, classes: done, pendingClasses: 0 };
  }
  return { term: { termId: term.termId, term: term.term }, classes: rows, pendingClasses: rows.filter((r) => r.pending > 0).length };
};

export const getHistory = async (studentId, user) => {
  const id = toInt(studentId, "studentId");
  // A Class Teacher office login sees only their own pupils (as with results).
  if (user && !hasPermission(user, P.ALL_CLASSES)) {
    const student = await Student.findOne({ where: { studentId: id }, attributes: ["class"], raw: true });
    if (!student) throw new AppError("Student not found", 404);
    try {
      await assertClassAccess(user, student.class);
    } catch (e) {
      throw new AppError("You can only see the history of pupils in your own class", 403);
    }
  }
  const rows = await StudentPromotion.findAll({
    where: { studentId: id },
    include: [{ model: Term, as: "term", attributes: ["term", "startDate", "endDate"], required: false }],
    order: [["decidedAt", "DESC"]],
  });
  return rows.map((r) => {
    const x = typeof r.toJSON === "function" ? r.toJSON() : r;
    const { term, ...rest } = x;
    return {
      ...rest,
      average: rest.average == null ? null : Number(rest.average),
      passMark: rest.passMark == null ? null : Number(rest.passMark),
      termName: term?.term ?? null,
      termStart: term?.startDate ?? null,
    };
  });
};
