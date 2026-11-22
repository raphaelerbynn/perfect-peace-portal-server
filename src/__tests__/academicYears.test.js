// B7: academic years and the terms in them. In-memory tables, no DB.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  AcademicYear: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn() },
  Term: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn() },
}));
jest.mock("../services/promotion.js", () => ({ __esModule: true, getStatus: jest.fn() }));

import sequelize from "../config/database.js";
import { AcademicYear, Term } from "../models/index.js";
import { fakeTable } from "../testSupport/fakeTable.js";
import {
  assertTermFitsYear,
  createYear,
  deleteYear,
  listYears,
  resolveTermYear,
  setCurrentYear,
  updateYear,
  validateYearInput,
} from "../services/academicYear.js";
import { activateTerm, createYearTerm, deleteTerm, editTerm, getTerms, referenceMessage, setTerm, TERM_REFERENCES } from "../services/term.js";

let years;
let terms;
const T = { LOCK: { UPDATE: "UPDATE" } };

beforeEach(() => {
  jest.clearAllMocks();
  years = [
    { academicYearId: 1, name: "2025/2026", startDate: "2025-08-01", endDate: "2026-07-31", status: "ACTIVE", isCurrent: true },
    { academicYearId: 2, name: "2026/2027", startDate: "2026-08-01", endDate: "2027-07-31", status: "UPCOMING", isCurrent: false },
  ];
  terms = [
    { termId: 10, academicYearId: 1, term: "1", startDate: "2025-09-08", endDate: "2025-12-18", active: false },
    { termId: 11, academicYearId: 1, term: "2", startDate: "2026-01-06", endDate: "2026-04-02", active: false },
    { termId: 12, academicYearId: 1, term: "3", startDate: "2026-04-27", endDate: "2026-07-24", active: true },
    { termId: 5, academicYearId: null, term: null, startDate: null, endDate: null, active: false }, // old, no dates
  ];
  fakeTable(AcademicYear, years, "academicYearId");
  fakeTable(Term, terms, "termId");
  sequelize.transaction.mockImplementation(async (cb) => cb(T));
  sequelize.query.mockResolvedValue([[{}]]);
});

const year = (id) => years.find((y) => y.academicYearId === id);

describe("years", () => {
  it("validates name and dates", () => {
    expect(validateYearInput({ name: " 2027/2028 ", startDate: "2027-08-01", endDate: "2028-07-31" })).toEqual({
      name: "2027/2028",
      startDate: "2027-08-01",
      endDate: "2028-07-31",
    });
    expect(() => validateYearInput({ name: "x", startDate: "2027-08-01", endDate: "2028-07-31" })).toThrow(/2–50/);
    expect(() => validateYearInput({ name: "2027/2028", startDate: "2028-08-01", endDate: "2028-07-31" })).toThrow(/start before/);
    expect(() => validateYearInput({ name: "2027/2028", startDate: "2027-02-30", endDate: "2028-07-31" })).toThrow(/valid date/);
    expect(() => validateYearInput({ name: "2027/2028" })).toThrow(/required/);
  });

  it("creates an UPCOMING year", async () => {
    const y = await createYear({ name: "2027/2028", startDate: "2027-08-01", endDate: "2028-07-31" });
    expect(y).toMatchObject({ name: "2027/2028", status: "UPCOMING", isCurrent: false });
  });

  it("refuses a duplicate name (any case) with 409", async () => {
    await expect(createYear({ name: "2026/2027", startDate: "2030-08-01", endDate: "2031-07-31" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses dates that overlap another year", async () => {
    await expect(createYear({ name: "Odd", startDate: "2027-01-01", endDate: "2027-12-31" })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/overlap the year 2026\/2027/),
    });
  });

  it("lists years newest first with their terms; terms without a year listed apart", async () => {
    const out = await listYears();
    expect(out.years.map((y) => y.name)).toEqual(["2026/2027", "2025/2026"]);
    expect(out.years[1].terms.map((t) => t.termId)).toEqual([10, 11, 12]);
    expect(out.unassignedTerms.map((t) => t.termId)).toEqual([5]);
  });

  it("renames; a taken name is 409", async () => {
    await updateYear(2, { name: "2026-27" });
    expect(year(2).name).toBe("2026-27");
    await expect(updateYear(2, { name: "2025/2026" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("won't move a year's dates so that a term falls outside", async () => {
    await expect(updateYear(1, { endDate: "2026-06-30" })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Term 3/) });
  });

  it("status: ACTIVE only via make-current; COMPLETED refused while the year has the open term", async () => {
    await expect(updateYear(2, { status: "ACTIVE" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(updateYear(1, { status: "COMPLETED" })).rejects.toMatchObject({ statusCode: 409 });
    terms[2].active = false;
    await updateYear(1, { status: "COMPLETED" });
    expect(year(1)).toMatchObject({ status: "COMPLETED", isCurrent: false });
  });

  it("make current: this year ACTIVE + current, the previous one COMPLETED", async () => {
    await setCurrentYear(2);
    expect(year(2)).toMatchObject({ status: "ACTIVE", isCurrent: true });
    expect(year(1)).toMatchObject({ status: "COMPLETED", isCurrent: false });
  });

  it("making an EARLIER year current again puts the later one back to UPCOMING", async () => {
    await setCurrentYear(2);
    await setCurrentYear(1);
    expect(year(1)).toMatchObject({ status: "ACTIVE", isCurrent: true });
    expect(year(2)).toMatchObject({ status: "UPCOMING", isCurrent: false });
  });

  it("delete: refused while it has terms; 404 when missing; otherwise removed", async () => {
    await expect(deleteYear(1)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/3 terms/) });
    await expect(deleteYear(99)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteYear("abc")).rejects.toMatchObject({ statusCode: 404 });
    await deleteYear(2);
    expect(years.map((y) => y.academicYearId)).toEqual([1]);
  });
});

describe("terms inside years", () => {
  it("finds the year from the term's start date, or refuses when there is none", async () => {
    expect((await resolveTermYear({ startDate: "2026-09-07" }, { transaction: T })).academicYearId).toBe(2);
    await expect(resolveTermYear({ startDate: "2030-09-07" }, { transaction: T })).rejects.toMatchObject({ statusCode: 400 });
    expect(await resolveTermYear({ startDate: "2030-09-07" }, { transaction: T, required: false })).toBeNull();
    await expect(resolveTermYear({ academicYearId: 99 }, { transaction: T })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("term dates must be inside the year; a term number only once per year", async () => {
    await expect(assertTermFitsYear(year(2), { term: "1", startDate: "2026-07-20", endDate: "2026-12-18" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertTermFitsYear(year(1), { term: "2", startDate: "2026-01-06", endDate: "2026-04-02" })).rejects.toMatchObject({ statusCode: 409 });
    // editing Term 2 itself is fine
    await expect(assertTermFitsYear(year(1), { term: "2", startDate: "2026-01-06", endDate: "2026-04-02" }, 11)).resolves.toBeUndefined();
  });

  it("adding a term to a year leaves it closed", async () => {
    const t = await createYearTerm(2, { term: "1", startDate: "2026-09-07", endDate: "2026-12-17" });
    expect(t).toMatchObject({ academicYearId: 2, term: "1", active: false });
    expect(terms.filter((x) => x.active).map((x) => x.termId)).toEqual([12]);
  });

  it("back-to-back terms are allowed; overlapping ones are not", async () => {
    await createYearTerm(2, { term: "1", startDate: "2026-09-07", endDate: "2026-12-17" });
    await expect(createYearTerm(2, { term: "2", startDate: "2026-12-17", endDate: "2027-03-30" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createYearTerm(2, { term: "2", startDate: "2026-12-18", endDate: "2027-03-30" })).resolves.toMatchObject({ term: "2" });
  });

  it("refuses a term number other than 1-3", async () => {
    await expect(createYearTerm(2, { term: "4", startDate: "2026-09-07", endDate: "2026-12-17" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("opening a term: refused while another is open; then makes its year current", async () => {
    const t = await createYearTerm(2, { term: "1", startDate: "2026-09-07", endDate: "2026-12-17" });
    await expect(activateTerm(t.termId)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Term 3 is still open/) });
    terms.find((x) => x.termId === 12).active = false;
    await activateTerm(t.termId);
    expect(terms.find((x) => x.termId === t.termId).active).toBe(true);
    expect(year(2)).toMatchObject({ isCurrent: true, status: "ACTIVE" });
    expect(year(1)).toMatchObject({ isCurrent: false, status: "COMPLETED" });
  });

  it("an old term with no year can't be opened until it is in a year", async () => {
    terms.find((x) => x.termId === 12).active = false;
    await expect(activateTerm(5)).rejects.toMatchObject({ statusCode: 400 });
    await expect(activateTerm(999)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("Set new term (Term details): goes in the year its dates fall in and makes that year current", async () => {
    await setTerm({ term: "1", startDate: "2026-09-07", endDate: "2026-12-17" });
    const created = terms.at(-1);
    expect(created).toMatchObject({ academicYearId: 2, active: true });
    expect(terms.filter((x) => x.active)).toHaveLength(1);
    expect(year(2).isCurrent).toBe(true);
  });

  it("Set new term with no year for its dates is refused before anything changes", async () => {
    await expect(setTerm({ term: "1", startDate: "2030-09-07", endDate: "2030-12-17" })).rejects.toMatchObject({ statusCode: 400 });
    expect(terms.find((x) => x.termId === 12).active).toBe(true);
  });

  it("editing an old term with no year and no matching year still works (left without a year)", async () => {
    terms.push({ termId: 6, academicYearId: null, term: "1", startDate: "2023-01-09", endDate: "2023-04-06", active: false });
    await editTerm({ term: "1", startDate: "2023-01-10", endDate: "2023-04-06" }, 6);
    expect(terms.find((x) => x.termId === 6)).toMatchObject({ startDate: "2023-01-10", academicYearId: null });
  });

  it("editing a term can't push it outside its year", async () => {
    await expect(editTerm({ term: "3", startDate: "2026-04-27", endDate: "2026-08-20" }, 12)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("term list carries the year's name", async () => {
    const list = await getTerms();
    expect(list.find((t) => t.termId === 11)).toMatchObject({ academicYearName: "2025/2026", academicYearIsCurrent: true });
    expect(list.find((t) => t.termId === 5)).toMatchObject({ academicYearName: null });
  });
});

describe("deleting a term", () => {
  it("names what still uses it", () => {
    expect(referenceMessage("Term 1", { mark: 3, payment: 1, result: 0 })).toBe("Term 1 can't be deleted: it still has 3 marks, 1 payment.");
    expect(referenceMessage("Term 1", { mark: 0 })).toBeNull();
  });

  it("refuses the open term", async () => {
    await expect(deleteTerm(12)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/open/) });
  });

  it("refuses a term with marks / payments, listing the counts", async () => {
    sequelize.query.mockResolvedValue([[{ c0: "2", c3: "40" }]]);
    await expect(deleteTerm(10)).rejects.toMatchObject({ statusCode: 409, message: "Term 1 can't be deleted: it still has 2 payments, 40 marks." });
    expect(terms.some((t) => t.termId === 10)).toBe(true);
  });

  it("counts every table that points at a term, in one Postgres query", async () => {
    sequelize.query.mockResolvedValue([[{}]]);
    await deleteTerm(10);
    const [sql, opts] = sequelize.query.mock.calls[0];
    expect(opts.replacements).toEqual({ id: 10 });
    for (const [, q] of TERM_REFERENCES) expect(sql).toContain(q);
    expect(sql).toMatch(/"dbo"\."Student_marks"/);
    expect(terms.some((t) => t.termId === 10)).toBe(false);
  });

  it("404 for a missing or malformed id", async () => {
    await expect(deleteTerm(999)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteTerm("1;drop")).rejects.toMatchObject({ statusCode: 404 });
  });
});
