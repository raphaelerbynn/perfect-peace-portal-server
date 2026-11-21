// Test support only (not used by the app).
// Tiny in-memory stand-in for a Sequelize model, for service tests with the
// models mocked. Understands the where-clauses the services use: equality,
// IN (arrays), null, Op.ne / lt / lte / gt / gte / iLike / in / or / and.
import { Op } from "sequelize";

const likeToRegex = (pattern) =>
  new RegExp(
    `^${String(pattern)
      .replace(/\\([\\%_])/g, "\u0000$1")
      .replace(/[.*+?^${}()|[\]]/g, "\\$&")
      .replace(/%/g, ".*")
      .replace(/_/g, ".")
      .replace(/\u0000(.)/g, (_, c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}$`,
    "i"
  );

const cmp = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));

const matchValue = (actual, cond) => {
  if (cond === null) return actual === null || actual === undefined;
  if (Array.isArray(cond)) return cond.some((c) => matchValue(actual, c));
  if (typeof cond === "object" && !(cond instanceof Date)) {
    return Object.getOwnPropertySymbols(cond).every((sym) => {
      const v = cond[sym];
      if (sym === Op.ne) return v === null ? actual != null : actual == null || String(actual) !== String(v);
      if (sym === Op.lt) return actual != null && cmp(actual, v) < 0;
      if (sym === Op.lte) return actual != null && cmp(actual, v) <= 0;
      if (sym === Op.gt) return actual != null && cmp(actual, v) > 0;
      if (sym === Op.gte) return actual != null && cmp(actual, v) >= 0;
      if (sym === Op.in) return v.some((x) => String(x) === String(actual));
      if (sym === Op.notIn) return !v.some((x) => String(x) === String(actual));
      if (sym === Op.iLike) return actual != null && likeToRegex(v).test(String(actual));
      throw new Error(`fakeTable: unsupported operator ${String(sym)}`);
    });
  }
  return actual != null && String(actual) === String(cond);
};

export const matches = (row, where = {}) => {
  const keysOk = Object.entries(where).every(([k, cond]) => matchValue(row[k], cond));
  const symsOk = Object.getOwnPropertySymbols(where).every((sym) => {
    if (sym === Op.or) return where[sym].some((w) => matches(row, w));
    if (sym === Op.and) return where[sym].every((w) => matches(row, w));
    throw new Error(`fakeTable: unsupported operator ${String(sym)}`);
  });
  return keysOk && symsOk;
};

/** Wires jest.fn() methods on `model` to an array of rows. */
export const fakeTable = (model, rows, idKey) => {
  const state = { rows };
  const sorted = (list, order) => {
    if (!order) return list;
    return [...list].sort((a, b) => {
      for (const [k, dir] of order) {
        const c = a[k] == null ? (b[k] == null ? 0 : 1) : b[k] == null ? -1 : cmp(a[k], b[k]);
        if (c) return dir === "DESC" ? -c : c;
      }
      return 0;
    });
  };
  model.findAll?.mockImplementation(async ({ where, order } = {}) =>
    sorted(state.rows.filter((r) => matches(r, where)), order).map((r) => ({ ...r }))
  );
  model.findOne?.mockImplementation(async ({ where, order } = {}) => {
    const r = sorted(state.rows.filter((x) => matches(x, where)), order)[0];
    return r ? { ...r } : null;
  });
  model.count?.mockImplementation(async ({ where } = {}) => state.rows.filter((r) => matches(r, where)).length);
  model.create?.mockImplementation(async (data) => {
    const id = Math.max(0, ...state.rows.map((r) => Number(r[idKey]) || 0)) + 1;
    const row = { [idKey]: id, ...data };
    state.rows.push(row);
    return { ...row };
  });
  model.update?.mockImplementation(async (patch, { where } = {}) => {
    const hit = state.rows.filter((r) => matches(r, where));
    hit.forEach((r) => Object.assign(r, patch));
    return [hit.length];
  });
  model.destroy?.mockImplementation(async ({ where } = {}) => {
    const before = rows.length;
    const keep = rows.filter((r) => !matches(r, where));
    rows.splice(0, rows.length, ...keep);
    return before - rows.length;
  });
  return state;
};
