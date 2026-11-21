import { DiscountType, StudentDiscount, Term } from "../models/index.js";
import { round2, sumMoney, toNum } from "../utils/money.js";

// ---------------------------------------------------------------------------
// B12: what a pupil is billed for a term = fee items - discounts.
// No imports from fee.js (fee.js uses this; avoids an import cycle).
//
// Discount rules (SchoolPro calculateAmountDue, with its gaps closed):
//   - PERCENT is taken off the FULL amount of the items it applies to (not off
//     what earlier discounts left), FIXED is a flat amount, capped at those items.
//   - A discount applies to every item, or only to items with its `appliesTo`
//     name (case and spaces ignored), e.g. "Tuition".
//   - Several discounts stack, in the order they were given; together they never
//     take the bill below 0 (the last ones are cut down to fit).
//   - Amounts are rounded to the pesewa (utils/money round2).
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Pure. items = [{ name, amount }], discounts = [{ name, kind, value, appliesTo }]
 * -> { gross, discount, net, lines: [{ name, amount }] }
 */
export const computeDiscounts = (items = [], discounts = []) => {
  const gross = sumMoney(items, "amount");
  // What is still left of each item after the discounts before (never below 0).
  const left = items.map((i) => Math.max(round2(toNum(i.amount)), 0));
  const lines = [];
  for (const d of discounts) {
    const idx = items.map((_, k) => k).filter((k) => !d.appliesTo || norm(items[k].name) === norm(d.appliesTo));
    const base = round2(idx.reduce((n, k) => n + toNum(items[k].amount), 0));
    const room = round2(idx.reduce((n, k) => n + left[k], 0));
    const value = toNum(d.value);
    let amount = d.kind === "PERCENT" ? round2((base * Math.min(Math.max(value, 0), 100)) / 100) : Math.min(Math.max(value, 0), base);
    // Capped at what earlier discounts left of ITS items (not of the whole bill).
    amount = round2(Math.min(amount, room));
    if (amount <= 0) {
      lines.push({ name: d.name, amount: 0 });
      continue;
    }
    // Take it off its items in proportion to what is left of each (to the pesewa).
    let toTake = amount;
    let roomLeft = room;
    idx.forEach((k, n) => {
      if (left[k] <= 0 || toTake <= 0) return;
      const last = n === idx.length - 1 || roomLeft <= left[k];
      const share = last ? Math.min(toTake, left[k]) : Math.min(round2((toTake * left[k]) / roomLeft), left[k]);
      roomLeft = round2(roomLeft - left[k]);
      left[k] = round2(left[k] - share);
      toTake = round2(toTake - share);
    });
    lines.push({ name: d.name, amount });
  }
  const discount = sumMoney(lines, "amount");
  return { gross, discount, net: round2(gross - discount), lines };
};

/** Orders terms by start date, then id (old terms may have no dates). */
export const termKey = (t) => `${t?.startDate ? String(t.startDate).slice(0, 10) : "0000-00-00"}#${String(t?.termId ?? 0).padStart(10, "0")}`;

/** Pure: does a pupil's discount (from term .. to term or open-ended) cover `term`? */
export const discountCoversTerm = (sd, term, termsById) => {
  const from = termsById.get(Number(sd.fromTermId));
  if (!from || !term) return false;
  if (termKey(term) < termKey(from)) return false;
  if (sd.toTermId == null) return true;
  const to = termsById.get(Number(sd.toTermId));
  return Boolean(to) && termKey(term) <= termKey(to);
};

/**
 * Discounts covering `termId` for each pupil: Map(studentId -> [{ name, kind, value, appliesTo }]),
 * in the order they were given. Inactive discount TYPES still apply to pupils
 * who already have them (deactivating only stops new ones). Sequential queries
 * (they may share the caller's transaction connection).
 */
export const discountsForTerm = async (studentIds, termId, { transaction = null } = {}) => {
  const out = new Map();
  const ids = [...new Set((studentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length || termId == null) return out;
  const given = await StudentDiscount.findAll({
    where: { studentId: ids },
    order: [["studentDiscountId", "ASC"]],
    raw: true,
    transaction,
  });
  if (!given.length) return out;
  const termIds = [...new Set([Number(termId), ...given.flatMap((g) => [g.fromTermId, g.toTermId]).filter((x) => x != null).map(Number)])];
  const terms = await Term.findAll({ where: { termId: termIds }, attributes: ["termId", "startDate"], raw: true, transaction });
  const termsById = new Map(terms.map((t) => [Number(t.termId), t]));
  const typeIds = [...new Set(given.map((g) => Number(g.discountTypeId)))];
  const types = await DiscountType.findAll({ where: { discountTypeId: typeIds }, raw: true, transaction });
  const typesById = new Map(types.map((t) => [Number(t.discountTypeId), t]));
  const term = termsById.get(Number(termId));
  for (const g of given) {
    const type = typesById.get(Number(g.discountTypeId));
    if (!type || !discountCoversTerm(g, term, termsById)) continue;
    const list = out.get(Number(g.studentId)) || [];
    list.push({ name: type.name, kind: type.kind, value: toNum(type.value), appliesTo: type.appliesTo || null, studentDiscountId: g.studentDiscountId });
    out.set(Number(g.studentId), list);
  }
  return out;
};
