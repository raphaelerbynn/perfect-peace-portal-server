import { Op } from "sequelize";
import { ClassFee, Student, StudentFee, Term } from "../models/index.js";
import { round2, toNum } from "../utils/money.js";

// ---------------------------------------------------------------------------
// B12 (client 2026-11-17): a class fee item is entered per TERM (default, the
// amount is billed every term, as before) or per YEAR (migration 048).
//
// THE RULES for a YEAR item:
//   - Split equally across the academic year's terms in whole cedis, the
//     remainder on the last term, so the year adds up exactly:
//     1000 over 3 terms = 333 / 333 / 334.
//   - The year's term count = the terms recorded for that year; while fewer
//     than 3 are recorded (terms are added one by one), 3 is assumed.
//   - Which share a term gets = its term number (Term 1 = first share), or its
//     place by date within the year when the number isn't 1..n.
//   - A fee period with no term yet (promotion, admission with no open term)
//     carries the FIRST share; the term that adopts it bills its own share.
//   - The term's share is billed exactly like a TERM item: same name (so
//     discounts "on Tuition" apply to it), arrears and discounts as before.
//   - What a term was billed is kept on the item (ClassFee.term_amounts):
//     written when the term is billed, and before a yearly amount or the
//     TERM / YEAR choice changes. A change therefore only reaches terms not
//     billed yet; a billed term keeps what it was billed. Items that are and
//     always were TERM keep today's behaviour (no entries: editing the amount
//     changes the current term's bill, as before).
// ---------------------------------------------------------------------------

export const FEE_PERIODS = ["TERM", "YEAR"];
export const ASSUMED_TERMS_PER_YEAR = 3;

export const normPeriod = (p) => (String(p ?? "").trim().toUpperCase() === "YEAR" ? "YEAR" : "TERM");

/**
 * Pure. A yearly amount split into `n` term shares: whole cedis, the remainder
 * (cedis and any pesewas) on the last share. Sums exactly to the amount.
 * splitYearly(1000, 3) -> [333, 333, 334]
 */
export const splitYearly = (amount, n = ASSUMED_TERMS_PER_YEAR) => {
  const terms = Math.max(1, Math.floor(Number(n) || ASSUMED_TERMS_PER_YEAR));
  const pesewas = Math.round(toNum(amount) * 100);
  const each = Math.floor(pesewas / 100 / terms) * 100; // whole cedis, in pesewas
  const out = Array.from({ length: terms }, () => each / 100);
  out[terms - 1] = (pesewas - each * (terms - 1)) / 100;
  return out;
};

const dateKey = (t) => `${t?.startDate ? String(t.startDate).slice(0, 10) : "0000-00-00"}#${String(t?.termId ?? 0).padStart(10, "0")}`;

/**
 * Pure. Where `term` sits in its academic year: { n, index, no, assumed, pinned }.
 * `terms` = terms to look in (only those of the same year count). term null
 * (a period no term has claimed yet) = the first of an assumed 3.
 * `pinnedN`: the term count an item's year was first billed with (review fix:
 * once a share is billed the count never changes, so a term added to the year
 * later can't make the year bill more than its amount). With a pinned count, a
 * term past it has index >= n (nothing left to bill).
 */
export const termPosition = (term, terms = [], { pinnedN = null } = {}) => {
  if (!term) return { n: ASSUMED_TERMS_PER_YEAR, index: 0, no: 1, assumed: true, untied: true };
  const same =
    term.academicYearId != null
      ? (terms || []).filter((t) => t.academicYearId != null && Number(t.academicYearId) === Number(term.academicYearId))
      : [];
  if (!same.some((t) => Number(t.termId) === Number(term.termId))) same.push(term);
  const count = term.academicYearId != null ? same.length : 0;
  const pinned = Number.isInteger(Number(pinnedN)) && Number(pinnedN) >= 1 ? Number(pinnedN) : null;
  const n = pinned ?? Math.max(ASSUMED_TERMS_PER_YEAR, count);
  const maxNo = Math.max(n, count);
  const num = Number.parseInt(String(term.term ?? "").trim(), 10);
  let index;
  if (Number.isInteger(num) && num >= 1 && num <= maxNo) index = num - 1;
  else {
    const rank = [...same].sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : 1)).findIndex((t) => Number(t.termId) === Number(term.termId));
    index = Math.max(rank, 0);
    if (!pinned) index = Math.min(index, n - 1);
  }
  return { n, index, no: index + 1, assumed: !pinned && count < ASSUMED_TERMS_PER_YEAR, ...(pinned ? { pinned: true } : {}) };
};

/**
 * THE share rule, in one place: what term `pos` bills of a yearly amount.
 * Today: the term's equal share of the CURRENT yearly amount (so after a
 * mid-year edit, unbilled terms bill the new amount ÷ terms). A term past the
 * year's (pinned) count bills 0. If the school later wants "what is left of the
 * new amount over the terms left", change only this function (`fee` carries
 * the billed entries in termAmounts).
 */
export const yearlyShare = (fee, pos) => (pos.index >= pos.n ? 0 : splitYearly(fee.amount, pos.n)[pos.index]);

/** "1,500" / "1,000.50" (whole cedis without decimals). */
export const cedis = (v) => {
  const n = round2(v);
  const [whole, dec] = Math.abs(n).toFixed(2).split(".");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${w}${dec === "00" ? "" : `.${dec}`}`;
};

/** "Tuition (yearly GH₵ 1,500 — Term 2 share)" */
export const yearlyLabel = (name, yearly, no, { beyond = false } = {}) =>
  `${String(name ?? "Fee").trim() || "Fee"} (yearly GH₵ ${cedis(yearly)} — ${beyond ? "already billed in full this year" : no ? `Term ${no} share` : "one term's share"})`;

const frozenFor = (fee, term) => {
  if (!term) return null;
  const all = fee?.termAmounts;
  if (!all || typeof all !== "object") return null;
  const e = all[String(term.termId)];
  return e && e.amount != null ? e : null;
};

const yearItem = (fee, { amount, yearly, no, of, year = null, assumed = false }) => {
  const beyond = no != null && of != null && Number(no) > Number(of);
  return {
    name: fee.name,
    amount: round2(amount),
    source: "CLASS",
    classFeeId: fee.classFeeId ?? null,
    period: "YEAR",
    yearly: round2(yearly),
    shareNo: no ?? null,
    shareOf: of ?? null,
    ...(year != null ? { year: Number(year) } : {}),
    ...(assumed ? { assumedTerms: true } : {}),
    label: yearlyLabel(fee.name, yearly, no, { beyond }),
  };
};

/**
 * Pure. The term count `fee`'s yearly amount was first billed with in `term`'s
 * year (the `of` of a YEAR entry for a term of that year), or null.
 */
export const pinnedTermCount = (fee, term, terms = []) => {
  if (!term || term.academicYearId == null) return null;
  const all = fee?.termAmounts && typeof fee.termAmounts === "object" ? fee.termAmounts : {};
  const sameYear = new Set(
    (terms || []).filter((t) => t.academicYearId != null && Number(t.academicYearId) === Number(term.academicYearId)).map((t) => Number(t.termId))
  );
  const hits = Object.entries(all)
    .filter(([termId, e]) => e && e.period === "YEAR" && Number(e.of) >= 1 && (e.year != null ? Number(e.year) === Number(term.academicYearId) : sameYear.has(Number(termId))))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return hits.length ? Number(hits[0][1].of) : null;
};

/** Pure: the position a YEAR item's share uses for `term` (pinned count applied). */
export const sharePosition = (fee, term, terms = []) => termPosition(term, terms, { pinnedN: pinnedTermCount(fee, term, terms) });

/**
 * Pure. The bill item a class fee gives for `term` (null = a period no term has
 * claimed yet). TERM items keep the exact shape they always had.
 */
export const classFeeItem = (fee, term, terms = []) => {
  const frozen = frozenFor(fee, term);
  if (frozen) {
    if (frozen.period === "YEAR") return yearItem(fee, { amount: frozen.amount, yearly: frozen.yearly, no: frozen.no, of: frozen.of, year: frozen.year ?? term?.academicYearId });
    return { name: fee.name, amount: round2(frozen.amount), source: "CLASS" };
  }
  if (normPeriod(fee.period) !== "YEAR") return { name: fee.name, amount: round2(fee.amount), source: "CLASS" };
  const pos = sharePosition(fee, term, terms);
  return yearItem(fee, {
    amount: yearlyShare(fee, pos),
    yearly: fee.amount,
    no: pos.untied ? null : pos.no,
    of: pos.n,
    year: term?.academicYearId ?? null,
    assumed: pos.assumed,
  });
};

/** Pure: does working out `term`'s items need the year's terms? */
export const needsYearTerms = (classFees, term) =>
  Boolean(term) && (classFees || []).some((f) => normPeriod(f.period) === "YEAR" && !frozenFor(f, term));

export const classFeeItems = (classFees, term, terms = []) => (classFees || []).map((f) => classFeeItem(f, term, terms));

/** The class fee attributes the share needs. */
export const CLASS_FEE_ATTRS = ["classFeeId", "name", "amount", "period", "termAmounts"];
const TERM_ATTRS = ["termId", "term", "startDate", "academicYearId"];

/** The terms of `term`'s academic year (one query; none without a year). */
export const loadYearTerms = async (term, { transaction = null } = {}) => {
  if (!term || term.academicYearId == null) return [];
  return Term.findAll({ where: { academicYearId: term.academicYearId }, attributes: TERM_ATTRS, raw: true, transaction });
};

/**
 * Items for a class's fees billed for `term` (a term row, a term id, or null).
 * Queries only when a YEAR item needs the year's terms (TERM-only classes run
 * no extra query). Sequential (may share the caller's transaction).
 */
export const itemsForTerm = async (classFees, term, opts = {}) => (await resolveItems(classFees, term, opts)).items;

const anyYearlyFee = (classFees) => (classFees || []).some((f) => normPeriod(f.period) === "YEAR" || (f.termAmounts && Object.keys(f.termAmounts).length));

/** itemsForTerm, also returning the term row it resolved (null if none was needed). */
const resolveItems = async (classFees, term, { transaction = null, terms = null } = {}) => {
  let t = term;
  if (!anyYearlyFee(classFees)) return { items: classFeeItems(classFees, null), term: null };
  if (t != null && typeof t !== "object") {
    t = await Term.findOne({ where: { termId: t }, attributes: TERM_ATTRS, raw: true, transaction });
  }
  const list = needsYearTerms(classFees, t) ? terms || (await loadYearTerms(t, { transaction })) : [];
  return { items: classFeeItems(classFees, t || null, list), term: t || null };
};

/** The entry kept on an item for a billed term. */
export const frozenEntry = (item) =>
  item.period === "YEAR"
    ? { period: "YEAR", amount: round2(item.amount), yearly: round2(item.yearly), no: item.shareNo ?? null, of: item.shareOf ?? null, year: item.year ?? null }
    : { period: "TERM", amount: round2(item.amount) };

/**
 * Keep what each YEAR item is billed at for `term` (when billing it). Only adds
 * missing entries; never changes one. Locks each item row it writes.
 * classFees and items are parallel (items = classFeeItems(classFees, term)).
 */
export const freezeYearShares = async (classFees, items, term, { transaction = null } = {}) => {
  if (!term) return 0;
  let n = 0;
  // Item rows are locked in classFeeId order (every path does the same), after
  // the caller has locked the pupils.
  const order = (classFees || []).map((f, k) => k).sort((a, b) => Number(classFees[a].classFeeId) - Number(classFees[b].classFeeId));
  for (const k of order) {
    const f = classFees[k];
    if (normPeriod(f.period) !== "YEAR" || frozenFor(f, term)) continue;
    n += (await addEntries(f.classFeeId, { [String(term.termId)]: frozenEntry(items[k]) }, { transaction })) ? 1 : 0;
  }
  return n;
};

/** Adds entries to one item's term_amounts (existing keys win). Row locked. */
const addEntries = async (classFeeId, entries, { transaction = null } = {}) => {
  const row = await ClassFee.findOne({
    where: { classFeeId },
    attributes: ["classFeeId", "termAmounts"],
    raw: true,
    transaction,
    ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row) return false;
  const current = row.termAmounts && typeof row.termAmounts === "object" ? row.termAmounts : {};
  const add = Object.fromEntries(Object.entries(entries).filter(([key]) => current[key] == null));
  if (!Object.keys(add).length) return false;
  await ClassFee.update({ termAmounts: { ...current, ...add } }, { where: { classFeeId }, transaction });
  return true;
};

/**
 * Before a yearly amount or the TERM / YEAR choice of `fee` changes: keep what
 * it is billed at now for every term the class's pupils are currently billed
 * for (their fee period's term), so the change only reaches terms not billed
 * yet. Returns the terms kept: [{ termId, term, amount }].
 */
export const freezeBilledTerms = async (fee, { transaction = null } = {}) => {
  if (fee?.classId == null) return [];
  const pupils = await Student.findAll({
    where: { classId: fee.classId, isDeleted: { [Op.not]: true }, feesPeriodTermId: { [Op.ne]: null } },
    attributes: ["studentId", "feesPeriodTermId"],
    raw: true,
    transaction,
  });
  const termIds = [...new Set(pupils.map((p) => Number(p.feesPeriodTermId)))];
  if (!termIds.length) return [];
  const terms = await Term.findAll({ where: { termId: termIds }, attributes: TERM_ATTRS, raw: true, transaction });
  const entries = {};
  const kept = [];
  for (const t of terms) {
    const yearTerms = needsYearTerms([fee], t) ? await loadYearTerms(t, { transaction }) : [];
    const item = classFeeItem(fee, t, yearTerms);
    entries[String(t.termId)] = frozenEntry(item);
    kept.push({ termId: t.termId, term: t.term ?? null, amount: round2(item.amount) });
  }
  await addEntries(fee.classFeeId, entries, { transaction });
  return kept;
};

/**
 * Everything on a pupil's current fee period: their class's items for the
 * period's term (YEAR items as that term's share) and their own fees.
 * pupil = { studentId, classId, feesPeriodTermId }. Sequential queries, in the
 * order recomputeStudentOwing always ran them (class fees, then pupil fees).
 */
export const periodItems = async (pupil, { transaction = null, freeze = false } = {}) => {
  const classFees =
    pupil.classId != null
      ? await ClassFee.findAll({ where: { classId: pupil.classId }, attributes: CLASS_FEE_ATTRS, order: [["classFeeId", "ASC"]], raw: true, transaction })
      : [];
  const { items: classItems, term } = await resolveItems(classFees, pupil.feesPeriodTermId ?? null, { transaction });
  // Review fix: a balance worked out on a term's live share (a pupil moved or
  // promoted into the class, a term not billed for the class) records that
  // share at once, so the balance can't later drift when terms are edited or
  // added. Only inside a transaction (the caller holds the pupil's lock first).
  if (freeze && transaction && term) await freezeYearShares(classFees, classItems, term, { transaction });
  const studentFees = await StudentFee.findAll({ where: { studentId: pupil.studentId }, attributes: ["name", "amount"], raw: true, transaction });
  const pupilItems = studentFees.map((f) => ({ name: f.name, amount: round2(f.amount), source: "PUPIL" }));
  return { classItems, pupilItems, items: [...classItems, ...pupilItems] };
};

// ---------------------------------------------------------------------------
// Reads. The office and portal screens add up `amount`; for a YEAR item that
// must be the term's share, not the yearly amount.
// ---------------------------------------------------------------------------

const hasYearly = (fees) => (fees || []).some((f) => f && (normPeriod(f.period) === "YEAR" || (f.termAmounts && Object.keys(f.termAmounts).length)));
const todayLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/**
 * Pure. The term the class fee screen previews: the open term, else the next
 * term to start, else none (the first share of an assumed 3).
 */
export const previewTerm = (terms = [], today = todayLocal()) =>
  terms.find((t) => t.active) ||
  [...terms].filter((t) => t.startDate && String(t.startDate).slice(0, 10) > today).sort((a, b) => (dateKey(a) < dateKey(b) ? -1 : 1))[0] ||
  null;

/**
 * Pure. Adds to a class fee row (raw, as stored) what the class fee screen
 * shows: the share for `term`, the year's split, and the terms already billed.
 */
export const describeClassFee = (fee, term, terms = [], termsById = new Map()) => {
  const period = normPeriod(fee.period);
  const item = classFeeItem(fee, term, terms);
  const pos = sharePosition(fee, term, terms);
  const billed = Object.entries(fee.termAmounts && typeof fee.termAmounts === "object" ? fee.termAmounts : {})
    .map(([termId, e]) => {
      const t = termsById.get(Number(termId));
      return { termId: Number(termId), term: t?.term ?? null, academicYearId: t?.academicYearId ?? null, period: e.period, amount: round2(e.amount) };
    })
    .sort((a, b) => a.termId - b.termId);
  return {
    ...fee,
    period,
    termShare: round2(item.amount),
    shareTermId: term?.termId ?? null,
    shareTerm: term ? term.term ?? null : null,
    split: period === "YEAR" ? splitYearly(fee.amount, pos.n) : null,
    assumedTerms: period === "YEAR" ? pos.assumed : false,
    billedTerms: billed,
  };
};

/**
 * The class fee list (classes()): each row with its share for the open term
 * (or the next term to start). No query when no item is or was yearly.
 */
export const annotateClassFeeList = async (rows) => {
  if (!hasYearly(rows)) return rows;
  const terms = await Term.findAll({ attributes: [...TERM_ATTRS, "active"], raw: true });
  const byId = new Map(terms.map((t) => [Number(t.termId), t]));
  // Review fix: preview each class on the term its pupils are billed for now
  // (the most common fee-period term in the class), not the open / next term,
  // so the class total matches the pupils' bills (e.g. in the holiday after
  // Term 2, before Term 3 is billed). A class with no billed pupils: the open
  // term, else the next term to start.
  const pupils = await Student.findAll({
    where: { isDeleted: { [Op.not]: true }, feesPeriodTermId: { [Op.ne]: null } },
    attributes: ["classId", "feesPeriodTermId"],
    raw: true,
  });
  const termOfClass = classTermMap(pupils);
  const fallback = previewTerm(terms);
  return rows.map((f) => describeClassFee(f, byId.get(termOfClass.get(Number(f.classId))) || fallback, terms, byId));
};

/** Pure: classId -> the fee-period term most of its pupils are on (ties: the later term id). */
export const classTermMap = (pupils) => {
  const counts = new Map();
  for (const p of pupils || []) {
    if (p.classId == null || p.feesPeriodTermId == null) continue;
    const c = counts.get(Number(p.classId)) || new Map();
    c.set(Number(p.feesPeriodTermId), (c.get(Number(p.feesPeriodTermId)) || 0) + 1);
    counts.set(Number(p.classId), c);
  }
  const out = new Map();
  for (const [classId, c] of counts) {
    const best = [...c.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    out.set(classId, best[0]);
  }
  return out;
};

/**
 * Pupils with their class's fee items (student.class_.classFee): each item's
 * `amount` becomes what the pupil's current fee period bills (a YEAR item =
 * that term's share), with `period`, `yearlyAmount` and `label` added. Works on
 * plain objects and Sequelize instances. No query when no item is yearly.
 */
export const applyPupilShares = async (students) => {
  const list = (Array.isArray(students) ? students : [students]).filter(Boolean);
  const feesOf = (s) => {
    const klass = s.class_ ?? s.dataValues?.class_;
    const fees = klass?.classFee ?? klass?.dataValues?.classFee;
    return Array.isArray(fees) ? fees : [];
  };
  const plainFee = (f) => f?.dataValues ?? f;
  const strip = () =>
    list.forEach((s) =>
      feesOf(s).forEach((f) => {
        delete plainFee(f).termAmounts;
      })
    );
  if (!list.some((s) => hasYearly(feesOf(s).map(plainFee)))) {
    strip();
    return students;
  }
  const terms = await Term.findAll({ attributes: TERM_ATTRS, raw: true });
  const byId = new Map(terms.map((t) => [Number(t.termId), t]));
  for (const s of list) {
    const termId = s.feesPeriodTermId ?? s.dataValues?.feesPeriodTermId ?? null;
    const term = termId != null ? byId.get(Number(termId)) || null : null;
    for (const f of feesOf(s)) {
      const row = plainFee(f);
      const item = classFeeItem(row, term, terms);
      row.period = normPeriod(row.period);
      if (item.period === "YEAR") {
        row.yearlyAmount = item.yearly;
        row.label = item.label;
      }
      row.amount = item.amount;
    }
  }
  strip();
  return students;
};
