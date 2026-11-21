import sequelize from "../config/database.js";
import { Class, ClassFee, Student, StudentFee, StudentPromotion, StudentTermBill, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { round2, sumMoney, toNum } from "../utils/money.js";
import { recomputeStudentOwing, startFeePeriod } from "./fee.js";
import { computeDiscounts, discountsForTerm, termKey } from "./feeBill.js";

// ---------------------------------------------------------------------------
// B12: "Bill this term" = per-term billing + arrears carry-forward, built on
// fee periods (services/fee.js). Preview -> confirm with the expected figures
// -> one transaction per class (the chunk), pupils locked.
//
// THE RULE: every term is billed exactly once per pupil.
//   A pupil's fee period either bills a term (Student.fees_period_term_id) or
//   is UNTIED: it holds exactly one bill no term has claimed yet (promotion put
//   the new class's bill on it; or the old system did, migration 030; or the
//   pupil was admitted while no term was open).
// For each pupil in the class, against term T:
//   NEW     their period bills the term just before T: start a new period for
//           T. What they still owe (or their credit) is carried in as arrears,
//           then T's bill (class fees + pupil fees - discounts) is added.
//   ADOPT   their period is untied: T takes it over (whatever date it began),
//           nothing is billed twice, T's discounts now apply. The next term
//           bills them NEW.
//   SKIP    no class (old records) | alumni class | already billed for T |
//           already on a later term | untied but promoted on T itself or later
//           (that bill belongs to the term after T).
// Which terms can be billed: the open term, or the next term to start (bills go
// out in the holiday). Never a later one: that would skip the term between.
// A class is refused (409) when a pupil would be billed NEW while a term
// between their period's term and T was never billed for them (bill that term
// first: open it again, bill it, then come back).
// Billing is idempotent: billing T again finds everyone ALREADY_BILLED.
// Existing balances: at go-live every pupil's current period is tied to the
// current term (migration 030), so billing that term changes nobody; only the
// next term's bill is new. New admissions are tied to the open term when they
// are added (tieAdmissionToOpenTerm).
// Like SchoolPro's rollover: the confirm carries the preview's count + total;
// if anything changed since (a payment, a fee edit), 409 and nothing is billed.
// ---------------------------------------------------------------------------

export const SKIP_REASONS = {
  NO_CLASS: "No class",
  ALUMNI: "Graduated / left",
  ALREADY_BILLED: "Already billed for this term",
  LATER_TERM: "Already billed for a later term",
  PROMOTED_FOR_NEXT_TERM: "Promoted at the end of this term: the new class's bill is for the next term",
};

const dateOnly = (d) => (d ? String(d).slice(0, 10) : null);
const todayLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const toId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${what} not found`, 404);
  return n;
};
/** "Term 2 (starts 2027-01-11)" */
export const termText = (t) =>
  t ? `Term ${t.term != null && String(t.term).trim() !== "" ? String(t.term).trim() : "?"}${t.startDate ? ` (starts ${dateOnly(t.startDate)})` : ""}` : "a term";

/**
 * Pure. pupil: { classId, feesPeriodTermId }, term: T, periodTerm: the term the
 * pupil's period bills (or null), klass: { isAlumni },
 * ctx: { billedForT, anchorTerm } (anchorTerm = the latest term the pupil was
 * promoted on, or the old system's promotion term; untied periods only).
 * -> { action: "NEW" | "ADOPT" | "SKIP", reason? }
 */
export const classifyPupil = (pupil, term, periodTerm, klass, { billedForT = false, anchorTerm = null } = {}) => {
  if (pupil.classId == null) return { action: "SKIP", reason: "NO_CLASS" };
  if (klass?.isAlumni) return { action: "SKIP", reason: "ALUMNI" };
  if (billedForT) return { action: "SKIP", reason: "ALREADY_BILLED" };
  if (pupil.feesPeriodTermId != null) {
    if (Number(pupil.feesPeriodTermId) === Number(term.termId)) return { action: "SKIP", reason: "ALREADY_BILLED" };
    if (periodTerm && termKey(periodTerm) > termKey(term)) return { action: "SKIP", reason: "LATER_TERM" };
    return { action: "NEW" };
  }
  // Untied: the period holds one bill no term has claimed. The first term
  // billed after it takes it over, whenever the period began. Only a term the
  // pupil was promoted on (or earlier) can't: that bill is for the term after.
  if (anchorTerm && termKey(term) <= termKey(anchorTerm)) return { action: "SKIP", reason: "PROMOTED_FOR_NEXT_TERM" };
  return { action: "ADOPT" };
};

/**
 * Pure. Only the open term, or the next term to start (the earliest dated term
 * that hasn't started yet). `terms` = every term (for "the next one").
 */
export const assertBillableTerm = (term, { terms = [], today = todayLocal() } = {}) => {
  if (!term) throw new AppError("Term not found", 404);
  if (!term.startDate) throw new AppError("This term has no dates, so it can't be billed", 400);
  if (term.active) return;
  if (dateOnly(term.startDate) <= today) {
    throw new AppError("Only the open term, or the next term to start, can be billed", 409);
  }
  const next = terms
    .filter((t) => t.startDate && dateOnly(t.startDate) > today)
    .sort((a, b) => (termKey(a) < termKey(b) ? -1 : 1))[0];
  if (next && Number(next.termId) !== Number(term.termId)) {
    throw new AppError(`Only the next term to start, ${termText(next)}, can be billed now. Billing a later term would skip the one in between.`, 409);
  }
};

/**
 * Pure. Dated terms strictly between the pupil's period term and T: terms that
 * would never be billed for them if T billed them NEW. Undated period terms
 * (very old data) can't be placed, so they never block.
 */
export const termsSkipped = (periodTerm, term, terms) => {
  if (!periodTerm?.startDate) return [];
  const lo = termKey(periodTerm);
  const hi = termKey(term);
  return terms.filter((t) => t.startDate && termKey(t) > lo && termKey(t) < hi).sort((a, b) => (termKey(a) < termKey(b) ? -1 : 1));
};

const TERM_ATTRS = ["termId", "term", "startDate", "active", "promotedByOldSystem"];

/** Everything about the terms a plan needs (loaded once per preview / bill). */
const loadTermContext = async ({ transaction = null } = {}) => {
  const terms = await Term.findAll({ attributes: TERM_ATTRS, raw: true, transaction });
  const byId = new Map(terms.map((t) => [Number(t.termId), t]));
  const oldSystem = terms.filter((t) => t.promotedByOldSystem).sort((a, b) => (termKey(a) < termKey(b) ? 1 : -1))[0] || null;
  return { terms, byId, oldSystem };
};

const later = (a, b) => (!a ? b : !b ? a : termKey(a) >= termKey(b) ? a : b);

const PUPIL_ATTRS = [
  "studentId", "fName", "mName", "lName", "classId", "feesOwing", "feesOpeningBalance", "feesBillAtStart",
  "feesPeriodTermId", "feesPeriodStartedAt", "feesPeriodAfterFeeId",
];

/**
 * Works out the bill for one class (read only unless the caller's transaction
 * locks the pupils). Queries run one after the other (one connection).
 */
const planClass = async (term, classId, ctx, { transaction = null, lock = false } = {}) => {
  const klass = await Class.findOne({ where: { classId }, attributes: ["classId", "name", "isAlumni"], raw: true, transaction });
  if (!klass) throw new AppError("Class not found", 404);
  const pupils = await Student.findAll({
    where: { classId, isDeleted: false },
    attributes: PUPIL_ATTRS,
    order: [["studentId", "ASC"]], // lock order: no deadlocks between two billers
    raw: true,
    transaction,
    ...(lock && transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const ids = pupils.map((p) => p.studentId);
  const billedForT = ids.length
    ? new Set((await StudentTermBill.findAll({ where: { studentId: ids, termId: term.termId }, attributes: ["studentId"], raw: true, transaction })).map((b) => Number(b.studentId)))
    : new Set();
  // Untied periods: the term each pupil was last promoted on.
  const untiedIds = pupils.filter((p) => p.feesPeriodTermId == null).map((p) => p.studentId);
  const promotions = untiedIds.length
    ? await StudentPromotion.findAll({ where: { studentId: untiedIds }, attributes: ["studentId", "termId"], raw: true, transaction })
    : [];
  const promotedOn = new Map();
  for (const pr of promotions) {
    const t = ctx.byId.get(Number(pr.termId));
    promotedOn.set(Number(pr.studentId), later(promotedOn.get(Number(pr.studentId)), t));
  }
  const classFees = await ClassFee.findAll({ where: { classId }, attributes: ["name", "amount"], raw: true, transaction });
  const studentFees = ids.length
    ? await StudentFee.findAll({ where: { studentId: ids }, attributes: ["studentId", "name", "amount"], raw: true, transaction })
    : [];
  const discounts = ids.length ? await discountsForTerm(ids, term.termId, { transaction }) : new Map();

  const rows = pupils.map((p) => {
    const periodTerm = p.feesPeriodTermId != null ? ctx.byId.get(Number(p.feesPeriodTermId)) || null : null;
    const anchorTerm = p.feesPeriodTermId == null ? later(promotedOn.get(Number(p.studentId)), ctx.oldSystem) : null;
    const { action, reason } = classifyPupil(p, term, periodTerm, klass, { billedForT: billedForT.has(Number(p.studentId)), anchorTerm });
    const missed = action === "NEW" ? termsSkipped(periodTerm, term, ctx.terms) : [];
    const items = [
      ...classFees.map((f) => ({ name: f.name, amount: round2(f.amount), source: "CLASS" })),
      ...studentFees.filter((f) => Number(f.studentId) === Number(p.studentId)).map((f) => ({ name: f.name, amount: round2(f.amount), source: "PUPIL" })),
    ];
    const d = computeDiscounts(items, discounts.get(Number(p.studentId)) || []);
    const owing = round2(toNum(p.feesOwing));
    let arrears = 0;
    let projected = owing;
    if (action === "NEW") {
      arrears = owing; // what is still owed (below 0 = credit) is carried in
      projected = round2(owing + d.net);
    } else if (action === "ADOPT") {
      // What was owed before the bill on the period: an old-system period's
      // opening balance already includes its bill (fees_bill_at_start).
      arrears = round2(toNum(p.feesOpeningBalance) - toNum(p.feesBillAtStart));
      projected = round2(owing - d.discount); // the bill is already on; discounts come off
    }
    return {
      studentId: p.studentId,
      name: fullName(p),
      action,
      reason: reason || null,
      reasonText: reason ? SKIP_REASONS[reason] : null,
      missedTerm: missed.length ? { termId: missed[0].termId, label: termText(missed[0]) } : null,
      arrears,
      items,
      gross: d.gross,
      discount: d.discount,
      discountLines: d.lines,
      net: d.net,
      currentOwing: owing,
      projected,
      afterFeeId: Number(p.feesPeriodAfterFeeId) || 0,
    };
  });

  const billed = rows.filter((r) => r.action === "NEW" || r.action === "ADOPT");
  const skipped = {};
  for (const r of rows) if (r.action === "SKIP") skipped[r.reason] = (skipped[r.reason] || 0) + 1;
  const missing = rows.filter((r) => r.missedTerm);
  const blocked = missing.length
    ? {
        termId: missing[0].missedTerm.termId,
        label: missing[0].missedTerm.label,
        pupils: missing.length,
        message: `${missing[0].missedTerm.label} was never billed for ${missing.length === 1 ? "1 pupil" : `${missing.length} pupils`} in ${klass.name} (${missing
          .slice(0, 3)
          .map((r) => r.name)
          .join(", ")}${missing.length > 3 ? ", …" : ""}). Billing this term would skip it. Bill ${missing[0].missedTerm.label} first (open it again, bill it, then come back).`,
      }
    : null;
  return {
    class: klass,
    rows,
    summary: {
      classId: klass.classId,
      name: klass.name,
      isAlumni: Boolean(klass.isAlumni),
      pupils: rows.length,
      toBill: rows.filter((r) => r.action === "NEW").length,
      toAdopt: rows.filter((r) => r.action === "ADOPT").length,
      skipped,
      blocked,
      arrearsTotal: sumMoney(billed, "arrears"),
      billTotal: sumMoney(rows.filter((r) => r.action === "NEW"), "gross"),
      discountTotal: sumMoney(billed, "discount"),
      expectedCount: billed.length,
      expectedTotal: sumMoney(billed, "projected"),
    },
  };
};

const loadTerm = async (termId, { transaction = null } = {}) => {
  const term = await Term.findOne({ where: { termId: toId(termId, "Term") }, raw: true, transaction });
  if (!term) throw new AppError("Term not found", 404);
  return term;
};

/**
 * Preview billing `termId`: with classId, that class's pupils; otherwise a
 * summary per class (plus pupils who are never billed: no class, or a class
 * that was deleted).
 */
export const previewTermBilling = async (termId, { classId } = {}) => {
  const term = await loadTerm(termId);
  const ctx = await loadTermContext();
  const billable = (() => {
    try {
      assertBillableTerm(term, { terms: ctx.terms });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  })();
  if (classId != null && classId !== "") {
    const plan = await planClass(term, toId(classId, "Class"), ctx);
    return { term, billable, ...plan.summary, rows: plan.rows };
  }
  const classes = await Class.findAll({ where: { isDeleted: false }, attributes: ["classId", "name"], order: [["name", "ASC"]], raw: true });
  const out = [];
  for (const c of classes) {
    // One class at a time (each plan is a handful of queries).
    out.push((await planClass(term, c.classId, ctx)).summary);
  }
  const noClass = await Student.count({ where: { classId: null, isDeleted: false } });
  // Pupils left in a class that was deleted: never billed either, so say so.
  const deleted = await Class.findAll({ where: { isDeleted: true }, attributes: ["classId", "name"], raw: true });
  const inDeleted = deleted.length
    ? await Student.findAll({ where: { classId: deleted.map((c) => c.classId), isDeleted: false }, attributes: ["studentId", "classId"], raw: true })
    : [];
  const deletedClasses = deleted
    .map((c) => ({ classId: c.classId, name: c.name, pupils: inDeleted.filter((p) => Number(p.classId) === Number(c.classId)).length }))
    .filter((c) => c.pupils > 0);
  return {
    term,
    billable,
    classes: out,
    noClassPupils: noClass,
    deletedClassPupils: inDeleted.length,
    deletedClasses,
    blocked: out.filter((c) => c.blocked).map((c) => ({ classId: c.classId, name: c.name, ...c.blocked })),
    totals: {
      toBill: out.reduce((n, c) => n + c.toBill, 0),
      toAdopt: out.reduce((n, c) => n + c.toAdopt, 0),
      arrearsTotal: sumMoney(out, "arrearsTotal"),
      billTotal: sumMoney(out, "billTotal"),
      discountTotal: sumMoney(out, "discountTotal"),
      expectedTotal: sumMoney(out, "expectedTotal"),
    },
  };
};

/**
 * Bill one class for `termId`. `expectedCount` / `expectedTotal` come from the
 * preview the office confirmed; if the class's figures have changed since,
 * 409 and nothing is billed (look again). One transaction; the class's pupils
 * are locked first (in id order), each pupil's balance is recomputed inside it.
 */
export const billClassForTerm = async ({ termId, classId, expectedCount, expectedTotal } = {}, { billedBy = null } = {}) => {
  if (expectedCount == null || expectedTotal == null || expectedCount === "" || expectedTotal === "") {
    throw new AppError("Preview the class first (expected count and total are required)", 400);
  }
  const cid = toId(classId, "Class");
  return sequelize.transaction(async (transaction) => {
    const term = await loadTerm(termId, { transaction });
    const ctx = await loadTermContext({ transaction });
    assertBillableTerm(term, { terms: ctx.terms });
    const plan = await planClass(term, cid, ctx, { transaction, lock: true });
    const s = plan.summary;
    if (s.blocked) {
      const err = new AppError(s.blocked.message, 409);
      err.fresh = s;
      throw err;
    }
    if (s.expectedCount !== Number(expectedCount) || round2(s.expectedTotal) !== round2(toNum(expectedTotal))) {
      const err = new AppError(
        `${s.name}'s figures changed since the preview (now ${s.expectedCount} pupils, GH₵ ${s.expectedTotal.toFixed(2)}). Nothing was billed: look at the preview again.`,
        409
      );
      err.fresh = s;
      throw err;
    }

    let billed = 0;
    let adopted = 0;
    let total = 0;
    for (const r of plan.rows) {
      if (r.action !== "NEW" && r.action !== "ADOPT") continue;
      let arrears = r.arrears;
      let afterFeeId = r.afterFeeId;
      if (r.action === "NEW") {
        const started = await startFeePeriod(r.studentId, { transaction, termId: term.termId });
        arrears = round2(started.arrears);
        afterFeeId = started.afterFeeId;
        billed += 1;
      } else {
        await Student.update({ feesPeriodTermId: term.termId }, { where: { studentId: r.studentId, feesPeriodTermId: null }, transaction });
        adopted += 1;
      }
      const now = await recomputeStudentOwing(r.studentId, { transaction });
      total = round2(total + (now?.owing ?? 0));
      await StudentTermBill.create(
        {
          studentId: r.studentId,
          termId: term.termId,
          classId: cid,
          kind: r.action === "NEW" ? "NEW" : "ADOPTED",
          arrears,
          bill: r.gross,
          discount: r.discount,
          items: r.items,
          discounts: r.discountLines.filter((l) => l.amount > 0),
          afterFeeId,
          billedBy,
        },
        { transaction }
      );
    }
    return { classId: cid, name: s.name, billed, adopted, skipped: s.skipped, total };
  });
};

/**
 * A new admission (services/test.js createStudent), inside its transaction:
 * the class bill on the new pupil's first period is the open term's bill, so
 * tie the period to the open term and record it as that term's (ADOPTED) bill.
 * Discounts for the term then apply at once, and the next term bills the pupil
 * NEW. With no term open, the period stays untied and the next term billed
 * takes it over (ADOPT). Recomputes the balance either way.
 */
export const tieAdmissionToOpenTerm = async (studentId, { transaction = null, billedBy = null } = {}) => {
  const open = await Term.findOne({ where: { active: true }, attributes: ["termId"], order: [["startDate", "DESC"]], raw: true, transaction });
  await Student.update(
    { feesPeriodStartedAt: new Date(), feesPeriodTermId: open ? open.termId : null },
    { where: { studentId }, transaction }
  );
  const now = await recomputeStudentOwing(studentId, { transaction });
  if (!open) return now;
  const p = await Student.findOne({
    where: { studentId },
    attributes: ["studentId", "classId", "feesOpeningBalance", "feesBillAtStart", "feesPeriodAfterFeeId"],
    raw: true,
    transaction,
  });
  const classFees = p.classId != null ? await ClassFee.findAll({ where: { classId: p.classId }, attributes: ["name", "amount"], raw: true, transaction }) : [];
  const studentFees = await StudentFee.findAll({ where: { studentId }, attributes: ["name", "amount"], raw: true, transaction });
  const items = [
    ...classFees.map((f) => ({ name: f.name, amount: round2(f.amount), source: "CLASS" })),
    ...studentFees.map((f) => ({ name: f.name, amount: round2(f.amount), source: "PUPIL" })),
  ];
  const d = computeDiscounts(items, (await discountsForTerm([studentId], open.termId, { transaction })).get(Number(studentId)) || []);
  await StudentTermBill.create(
    {
      studentId,
      termId: open.termId,
      classId: p.classId ?? null,
      kind: "ADOPTED",
      arrears: round2(toNum(p.feesOpeningBalance) - toNum(p.feesBillAtStart)),
      bill: d.gross,
      discount: d.discount,
      items,
      discounts: d.lines.filter((l) => l.amount > 0),
      afterFeeId: Number(p.feesPeriodAfterFeeId) || 0,
      billedBy,
    },
    { transaction }
  );
  return now;
};
