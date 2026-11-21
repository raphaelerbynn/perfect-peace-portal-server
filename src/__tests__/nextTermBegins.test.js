// A5a: "next term begins" is stored per term and printed on report cards.
// Close term (old behaviour: promotes, then closes) is tested in closeTerm.test.js.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(async (cb) => cb({ id: "t" })) } }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Term: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
}));

import { Term } from "../models/index.js";
import { setTerm, editTerm, validateNextTermBegins } from "../services/term.js";

const TERM = { term: "1", startDate: "2026-09-08", endDate: "2026-12-17" };

beforeEach(() => {
  jest.clearAllMocks();
  Term.findOne.mockImplementation(async ({ where }) => (where.termId === 15 ? { termId: 15, active: true } : null)); // no overlaps
});

describe("validateNextTermBegins", () => {
  it("empty / missing → null (optional)", () => {
    expect(validateNextTermBegins({ ...TERM })).toBeNull();
    expect(validateNextTermBegins({ ...TERM, nextTermBegins: "" })).toBeNull();
    expect(validateNextTermBegins({ ...TERM, nextTermBegins: null })).toBeNull();
  });
  it("keeps a date after the term ends (timestamps trimmed to the date)", () => {
    expect(validateNextTermBegins({ ...TERM, nextTermBegins: "2027-01-12" })).toBe("2027-01-12");
    expect(validateNextTermBegins({ ...TERM, nextTermBegins: "2027-01-12T00:00:00.000Z" })).toBe("2027-01-12");
  });
  it.each(["2026-12-17", "2026-10-01"])("refuses %s (not after the term ends)", (d) => {
    expect(() => validateNextTermBegins({ ...TERM, nextTermBegins: d })).toThrow(/after this term ends/);
  });
  it.each(["next week", "2027-13-45", "12/01/2027", "2027-02-30", "2027-04-31"])("refuses an invalid date %s", (d) => {
    expect(() => validateNextTermBegins({ ...TERM, nextTermBegins: d })).toThrow(/valid date/);
  });
});

describe("saving a term", () => {
  it("a new term stores next term begins", async () => {
    await setTerm({ ...TERM, nextTermBegins: "2027-01-12" });
    expect(Term.create).toHaveBeenCalledWith(expect.objectContaining({ nextTermBegins: "2027-01-12", active: true }), expect.anything());
  });
  it("a bad date is refused before anything changes", async () => {
    await expect(setTerm({ ...TERM, nextTermBegins: "2026-11-01" })).rejects.toMatchObject({ statusCode: 400 });
    expect(Term.update).not.toHaveBeenCalled();
    expect(Term.create).not.toHaveBeenCalled();
  });
  it("editing sets it, and an empty value clears it", async () => {
    await editTerm({ ...TERM, nextTermBegins: "2027-01-12" }, 15);
    expect(Term.update.mock.calls.at(-1)[0]).toMatchObject({ nextTermBegins: "2027-01-12" });
    await editTerm({ ...TERM, nextTermBegins: "" }, 15);
    expect(Term.update.mock.calls.at(-1)[0]).toMatchObject({ nextTermBegins: null });
  });
  it("an edit without the field (older screens) leaves it alone", async () => {
    await editTerm({ ...TERM }, 15);
    expect(Term.update.mock.calls.at(-1)[0]).not.toHaveProperty("nextTermBegins");
  });
});
