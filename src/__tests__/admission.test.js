// B18: admission number format, next number, clashes. The database is a small
// in-memory fake behind sequelize.query (no Postgres).
jest.mock("../config/database.js", () => ({ __esModule: true, default: { query: jest.fn() } }));

import sequelize from "../config/database.js";
import {
  admissionScope,
  assertAdmissionNoFree,
  normaliseAdmissionNo,
  parseAdmissionFormat,
  peekNextAdmissionNo,
  renderAdmissionNo,
  resolveNewAdmissionNo,
  sequenceOf,
  takeNextAdmissionNo,
} from "../services/admission.js";

const D2026 = new Date(Date.UTC(2026, 8, 1));
const D2027 = new Date(Date.UTC(2027, 0, 10));

let pupils; // [{ studentId, admissionNo, fName, lName }]
let counters; // scope -> last value
let locks; // scopes locked FOR UPDATE

beforeEach(() => {
  pupils = [];
  counters = {};
  locks = [];
  sequelize.query.mockImplementation(async (sql, { replacements: r = {} } = {}) => {
    if (sql.includes('FROM "dbo"."Admission_counter"')) {
      if (sql.includes("FOR UPDATE")) locks.push(r.scope);
      return r.scope in counters ? [{ lastValue: counters[r.scope] }] : [];
    }
    if (sql.startsWith("INSERT INTO \"dbo\".\"Admission_counter\"")) {
      if (!(r.scope in counters)) counters[r.scope] = r.seed;
      return [];
    }
    if (sql.startsWith("UPDATE \"dbo\".\"Admission_counter\"")) {
      counters[r.scope] = r.seq;
      return [];
    }
    if (sql.includes("LIKE lower(:prefix)")) {
      const prefix = r.prefix.replace(/\\(.)/g, "$1").toLowerCase();
      return pupils.filter((p) => p.admissionNo && p.admissionNo.toLowerCase().startsWith(prefix)).map((p) => ({ admissionNo: p.admissionNo }));
    }
    if (sql.includes("lower(s.admission_no) = lower(:no)")) {
      return pupils.filter((p) => p.admissionNo?.toLowerCase() === r.no.toLowerCase() && p.studentId !== r.except).slice(0, 1);
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
});

describe("parseAdmissionFormat", () => {
  it.each(["PPS/{YYYY}/{0000}", "ACM-{0000}", "{000}/{YY}", "PP {00000000}", "  STU-{0}  ", "PERFECT PEACE PREP/{YY}/{0}" /* 30 at 8 digits */])("accepts %j", (f) => {
    expect(parseAdmissionFormat(f)).toBe(f.trim());
  });
  it.each([null, undefined, "", "   "])("blank %j = no automatic numbers", (f) => expect(parseAdmissionFormat(f)).toBeNull());
  it.each([
    ["PPS-", /exactly one running number/],
    ["{000}-{000}", /exactly one running number/],
    ["PPS-{000000000}", /1 to 8 digits/],
    ["PPS/{MM}/{0000}", /Unknown part/],
    ["PPS/{0000", /exactly one running number/],
    ["PPS<script>{0000}", /only use letters/],
    ["A".repeat(41) + "{0}", /at most 40/],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZ/{YYYY}/{0000}", /at most 30/],
    // 30 characters with number 1, but 31 from pupil 10: refused up front.
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZ12/{0}", /at most 30/],
    // 27 characters up to 9999, 31 once the number grows to 8 digits.
    ["PERFECT PEACE PREPS/{YY}/{0000}", /at most 30/],
  ])("refuses %j", (f, msg) => {
    expect(() => parseAdmissionFormat(f)).toThrow(msg);
    try {
      parseAdmissionFormat(f);
    } catch (e) {
      expect(e.statusCode).toBe(400);
    }
  });
});

describe("render / scope / sequenceOf", () => {
  it("fills the year and pads the running number", () => {
    expect(renderAdmissionNo("PPS/{YYYY}/{0000}", 12, D2026)).toBe("PPS/2026/0012");
    expect(renderAdmissionNo("{000}/{YY}", 1, D2026)).toBe("001/26");
  });
  it("past the padding the number just gets longer", () => {
    expect(renderAdmissionNo("ACM-{00}", 100)).toBe("ACM-100");
  });
  it("the scope restarts each year when the format has a year", () => {
    expect(admissionScope("PPS/{YYYY}/{0000}", D2026)).toBe("PPS/2026/{0000}");
    expect(admissionScope("PPS/{YYYY}/{0000}", D2027)).toBe("PPS/2027/{0000}");
    expect(admissionScope("ACM-{0000}", D2026)).toBe("ACM-{0000}");
  });
  it("reads the running number of an existing number (any case / padding), else null", () => {
    expect(sequenceOf("PPS/2026/{0000}", "pps/2026/0041")).toBe(41);
    expect(sequenceOf("PPS/2026/{0000}", "PPS/2026/12345")).toBe(12345);
    expect(sequenceOf("{000}/24", "002/24")).toBe(2);
    expect(sequenceOf("PPS/2026/{0000}", "PPS/2025/0041")).toBeNull();
    expect(sequenceOf("A.{0}", "AX5")).toBeNull(); // "." is literal, not "any character"
  });
});

describe("takeNextAdmissionNo", () => {
  const t = { id: "tx" };

  it("first pupil of the year gets 0001, then 0002; the counter row is locked", async () => {
    expect(await takeNextAdmissionNo("PPS/{YYYY}/{0000}", { transaction: t, date: D2026 })).toBe("PPS/2026/0001");
    expect(await takeNextAdmissionNo("PPS/{YYYY}/{0000}", { transaction: t, date: D2026 })).toBe("PPS/2026/0002");
    expect(locks).toContain("PPS/2026/{0000}");
    expect(counters["PPS/2026/{0000}"]).toBe(2);
  });

  it("a new year starts again at 0001", async () => {
    counters["PPS/2026/{0000}"] = 57;
    expect(await takeNextAdmissionNo("PPS/{YYYY}/{0000}", { transaction: t, date: D2027 })).toBe("PPS/2027/0001");
  });

  it("a new counter starts after numbers already typed by hand (any case), ignoring other formats", async () => {
    pupils = [
      { studentId: 1, admissionNo: "ACM-0041" },
      { studentId: 2, admissionNo: "acm-0099" },
      { studentId: 3, admissionNo: "ACM-X12" },
      { studentId: 4, admissionNo: "STU/5" },
    ];
    expect(await takeNextAdmissionNo("ACM-{0000}", { transaction: t })).toBe("ACM-0100");
  });

  it("skips a number someone typed by hand after the counter was made", async () => {
    counters["ACM-{0000}"] = 4;
    pupils = [{ studentId: 1, admissionNo: "acm-0005" }, { studentId: 2, admissionNo: "ACM-0006" }];
    expect(await takeNextAdmissionNo("ACM-{0000}", { transaction: t })).toBe("ACM-0007");
    expect(counters["ACM-{0000}"]).toBe(7);
  });

  it("a too-long number (format saved before the width check) is a clean 400, the counter untouched", async () => {
    const old = "ABCDEFGHIJKLMNOPQRSTUVWXYZ12/{0}"; // 30 chars for 1-9, 31 from 10
    counters[old] = 9;
    await expect(takeNextAdmissionNo(old, { transaction: t })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/longer than 30 characters.*Type one by hand/),
    });
    expect(counters[old]).toBe(9);
  });

  it("needs a transaction (the lock is only held inside one)", async () => {
    await expect(takeNextAdmissionNo("ACM-{0000}", {})).rejects.toThrow(/transaction/);
  });
});

describe("peekNextAdmissionNo (form suggestion)", () => {
  it("shows the next number without reserving it", async () => {
    counters["PPS/2026/{0000}"] = 9;
    expect(await peekNextAdmissionNo("PPS/{YYYY}/{0000}", { date: D2026 })).toBe("PPS/2026/0010");
    expect(counters["PPS/2026/{0000}"]).toBe(9);
    expect(locks).toEqual([]);
  });
  it("no format = no suggestion", async () => expect(await peekNextAdmissionNo(null)).toBeNull());
});

describe("typed admission numbers", () => {
  it("normalises spaces; blank is null; refuses odd characters and long ones", () => {
    expect(normaliseAdmissionNo("  PPS/2026/  0001 ")).toBe("PPS/2026/ 0001");
    expect(normaliseAdmissionNo("   ")).toBeNull();
    expect(() => normaliseAdmissionNo("PPS'; DROP")).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => normaliseAdmissionNo("A".repeat(31))).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("a number another pupil has (any case) is a 409 naming them; the pupil's own is fine", async () => {
    pupils = [{ studentId: 1, admissionNo: "ACM-1632", fName: "Ama", lName: "Mensah" }];
    await expect(assertAdmissionNoFree("acm-1632")).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("Ama Mensah") });
    await expect(assertAdmissionNoFree("ACM-1632", { exceptStudentId: 1 })).resolves.toBeUndefined();
  });

  it("new pupil: a typed number wins and the counter is untouched; blank takes the next", async () => {
    const t = { id: "tx" };
    expect(await resolveNewAdmissionNo(" PPS/OLD/7 ", { format: "PPS/{YYYY}/{0000}", transaction: t })).toBe("PPS/OLD/7");
    expect(counters).toEqual({});
    expect(await resolveNewAdmissionNo("", { format: "ACM-{0000}", transaction: t })).toBe("ACM-0001");
    expect(await resolveNewAdmissionNo(undefined, { format: null, transaction: t })).toBeNull();
    pupils = [{ studentId: 1, admissionNo: "ACM-1632", fName: "Ama" }];
    await expect(resolveNewAdmissionNo("acm-1632", { format: "ACM-{0000}", transaction: t })).rejects.toMatchObject({ statusCode: 409 });
  });
});
