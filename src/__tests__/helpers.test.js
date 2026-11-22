// Phase 0.4.6: shared helpers for the proposal features.
import { formatGhs, round2, sumMoney, toNum } from "../utils/money.js";
import { paginatedResponse, parsePagination } from "../utils/pagination.js";

jest.mock("../models/index.js", () => ({ Term: { findOne: jest.fn() } }));
jest.mock("../config/database.js", () => ({ transaction: jest.fn() }));
const { Term } = require("../models/index.js");
const { requireActiveTerm } = require("../services/term.js");

describe("money", () => {
  it("toNum reads Sequelize DECIMAL strings, commas and empty values", () => {
    expect(toNum("350.50")).toBe(350.5);
    expect(toNum("1,200")).toBe(1200);
    expect(toNum(null)).toBe(0);
    expect(toNum("")).toBe(0);
  });
  it("toNum throws on garbage instead of returning NaN", () => {
    expect(() => toNum("abc")).toThrow(/Not a money amount/);
  });
  it("round2 rounds half away from zero", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2("2.344")).toBe(2.34);
  });
  it("sumMoney is exact to the pesewa", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([{ paid: "100.10" }, { paid: "200.20" }], "paid")).toBe(300.3);
  });
  it("formatGhs", () => {
    expect(formatGhs(1234.5)).toBe("GH₵ 1,234.50");
  });
});

describe("pagination", () => {
  it("returns null when no limit is given (old clients get the full list)", () => {
    expect(parsePagination({})).toBeNull();
    expect(parsePagination({ page: "2" })).toBeNull();
    expect(parsePagination({ limit: "0" })).toBeNull();
  });
  it("computes offset and defaults page to 1", () => {
    expect(parsePagination({ limit: "20" })).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(parsePagination({ limit: "20", page: "3" })).toEqual({ page: 3, limit: 20, offset: 40 });
  });
  it("caps the limit", () => {
    expect(parsePagination({ limit: "100000" }).limit).toBe(200);
    expect(parsePagination({ limit: "50" }, { maxLimit: 25 }).limit).toBe(25);
  });
  it("builds the /students-style response", () => {
    expect(paginatedResponse("rows", { rows: [1, 2], count: 45 }, { page: 2, limit: 20 })).toEqual({
      rows: [1, 2], total: 45, page: 2, limit: 20, totalPages: 3,
    });
  });
});

describe("requireActiveTerm", () => {
  it("returns the active term", async () => {
    Term.findOne.mockResolvedValue({ termId: 2, active: true });
    await expect(requireActiveTerm()).resolves.toEqual({ termId: 2, active: true });
  });
  it("throws 409 when no term is open", async () => {
    Term.findOne.mockResolvedValue(null);
    await expect(requireActiveTerm()).rejects.toMatchObject({ statusCode: 409 });
  });
});
