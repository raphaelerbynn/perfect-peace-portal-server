// B8: grading scales (services/grading.js). Models mocked; the band rules are pure.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: {
    transaction: jest.fn(async (cb) => cb({})),
    query: jest.fn(),
    where: jest.fn((a, b) => ({ where: [a, b] })),
    fn: jest.fn((name, ...args) => ({ fn: name, args })),
    col: jest.fn((c) => ({ col: c })),
  },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findAll: jest.fn() },
  GradingScale: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn() },
  GradeBand: { findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  GradingScaleSection: { findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() },
}));

import sequelize from "../config/database.js";
import { Class, GradeBand, GradingScale, GradingScaleSection } from "../models/index.js";
import {
  DEFAULT_JHS_BANDS,
  DEFAULT_PRIMARY_BANDS,
  createScale,
  deleteScale,
  makeGrader,
  pickScale,
  resolveGrade,
  updateScale,
  validateBands,
} from "../services/grading.js";
import { computeMarkFields } from "../services/results.js";

// What the system printed before B8, copied from the old code:
// server results.js gradeRemark (and admin AddStudentResult / portal teacherApi).
const oldRemark = (m) => {
  if (m < 40) return "Fail";
  if (m < 50) return "Pass";
  if (m < 60) return "Credit";
  if (m < 70) return "Good";
  if (m < 80) return "Very Good";
  return "Excellent";
};
// portal ResultsContent getGrade (JHS report card).
const oldJhsGrade = (mark) => {
  if (mark >= 90) return 1;
  if (mark >= 80) return 2;
  if (mark >= 70) return 3;
  if (mark >= 60) return 4;
  if (mark >= 55) return 5;
  if (mark >= 50) return 6;
  if (mark >= 40) return 7;
  if (mark >= 35) return 8;
  return 9;
};
// Every stored total: 0.00 .. 100.00 in steps of 0.01.
const ALL_TOTALS = Array.from({ length: 10001 }, (_, i) => i / 100);

describe("default bands = today's report cards", () => {
  it("primary: the same remark as before for every total 0–100 (2 d.p.)", () => {
    const diff = ALL_TOTALS.filter((t) => resolveGrade(t, DEFAULT_PRIMARY_BANDS).remark !== oldRemark(t));
    expect(diff).toEqual([]);
    expect(ALL_TOTALS.every((t) => resolveGrade(t, DEFAULT_PRIMARY_BANDS).grade === null)).toBe(true);
  });

  it("JHS: the same 1–9 grade AND the same remark as before for every total", () => {
    const diff = ALL_TOTALS.filter((t) => {
      const g = resolveGrade(t, DEFAULT_JHS_BANDS);
      return g.grade !== String(oldJhsGrade(t)) || g.remark !== oldRemark(t);
    });
    expect(diff).toEqual([]);
  });

  it("the save path's remark is unchanged (computeMarkFields)", () => {
    const sub = { name: "Maths", classTotalMarks: 30, examTotalMarks: 70, classPercentage: 30, examPercentage: 70 };
    expect(computeMarkFields(sub, 12, 27.5).remarks).toBe(oldRemark(39.5));
    expect(computeMarkFields(sub, 30, 70).remarks).toBe("Excellent");
  });

  it("both default scales pass the band rules (the migration seeds them)", () => {
    expect(() => validateBands(DEFAULT_PRIMARY_BANDS)).not.toThrow();
    expect(() => validateBands(DEFAULT_JHS_BANDS)).not.toThrow();
  });
});

describe("resolveGrade (highest min <= score; max ignored)", () => {
  const WAEC = [
    { grade: "F9", remark: "Fail", minScore: 0, maxScore: 49 },
    { grade: "D7", remark: "Pass", minScore: 50, maxScore: 59 },
    { grade: "C4", remark: "Credit", minScore: 60, maxScore: 69 },
    { grade: "B2", remark: "Very good", minScore: 70, maxScore: 79 },
    { grade: "A1", remark: "Excellent", minScore: 80, maxScore: 100 },
  ];
  it.each([
    [0, "F9"], [49, "F9"], [49.8, "F9"], [49.99, "F9"], [50, "D7"], [59.5, "D7"], [69.01, "C4"],
    [79.99, "B2"], [80, "A1"], [100, "A1"], [100.5, "A1"], ["80", "A1"],
  ])("%p -> %p", (score, grade) => {
    expect(resolveGrade(score, WAEC).grade).toBe(grade);
  });
  it.each([[-1], [NaN], [null], [undefined], [""], ["abc"]])("%p -> null", (score) => {
    expect(resolveGrade(score, WAEC)).toBeNull();
  });
  it("doesn't reorder the bands it is given", () => {
    const bands = [WAEC[4], WAEC[0], WAEC[2]];
    resolveGrade(65, bands);
    expect(bands.map((b) => b.grade)).toEqual(["A1", "F9", "C4"]);
    expect(resolveGrade(49.8, bands)).toEqual({ grade: "F9", remark: "Fail" });
  });
});

describe("validateBands", () => {
  const ok = [
    { grade: "B", remark: "Pass", minScore: "50", maxScore: "100" },
    { grade: "", remark: " Fail ", minScore: 0, maxScore: 50 },
  ];
  it("sorts low to high, trims, blank grade = none; touching bands are fine", () => {
    expect(validateBands(ok)).toEqual([
      { grade: null, remark: "Fail", minScore: 0, maxScore: 50 },
      { grade: "B", remark: "Pass", minScore: 50, maxScore: 100 },
    ]);
  });
  it("gaps are allowed", () => {
    expect(() => validateBands([{ remark: "F", minScore: 0, maxScore: 39 }, { remark: "P", minScore: 40, maxScore: 100 }])).not.toThrow();
  });
  it.each([
    ["no bands", [], /at least one/],
    ["overlap", [{ remark: "F", minScore: 0, maxScore: 55 }, { remark: "P", minScore: 50, maxScore: 100 }], /overlaps/],
    ["min above max", [{ remark: "F", minScore: 0, maxScore: 10 }, { remark: "P", minScore: 60, maxScore: 50 }], /above the highest/],
    ["over 100", [{ remark: "F", minScore: 0, maxScore: 101 }], /0 to 100/],
    ["negative", [{ remark: "F", minScore: -5, maxScore: 100 }], /number from 0 to 100/],
    ["not a number", [{ remark: "F", minScore: 0, maxScore: "lots" }], /number from 0 to 100/],
    ["3 decimals", [{ remark: "F", minScore: 0, maxScore: 39.999 }], /2 decimal/],
    ["no remark", [{ grade: "A", remark: " ", minScore: 0, maxScore: 100 }], /enter a remark/],
    ["long grade", [{ grade: "ABCDEFGHIJK", remark: "x", minScore: 0, maxScore: 100 }], /at most 10/],
    ["long remark", [{ remark: "x".repeat(51), minScore: 0, maxScore: 100 }], /at most 50/],
    ["doesn't start at 0", [{ remark: "P", minScore: 10, maxScore: 100 }], /must start at 0/],
    ["same grade twice", [{ grade: "a", remark: "x", minScore: 0, maxScore: 49 }, { grade: "A", remark: "y", minScore: 50, maxScore: 100 }], /used twice/],
    ["same start", [{ remark: "x", minScore: 0, maxScore: 0 }, { remark: "y", minScore: 0, maxScore: 100 }], /both start at 0/],
  ])("refuses %s (400)", (_, bands, msg) => {
    expect(() => validateBands(bands)).toThrow(msg);
    try {
      validateBands(bands);
    } catch (e) {
      expect(e.statusCode ?? e.status).toBe(400);
    }
  });
});

describe("pickScale", () => {
  const scales = [
    { gradingScaleId: 1, name: "Primary", isDefault: true, sections: [], bands: DEFAULT_PRIMARY_BANDS },
    { gradingScaleId: 2, name: "JHS", isDefault: false, sections: ["JHS"], bands: DEFAULT_JHS_BANDS },
    { gradingScaleId: 3, name: "Empty", isDefault: false, sections: ["KG"], bands: [] },
  ];
  it("the section's own scale (case and spaces ignored)", () => expect(pickScale(scales, " jhs ").gradingScaleId).toBe(2));
  it("else the default", () => expect(pickScale(scales, "Upper Primary").gradingScaleId).toBe(1));
  it("no section -> default", () => expect(pickScale(scales, null).gradingScaleId).toBe(1));
  it("a scale with no bands is ignored", () => expect(pickScale(scales, "KG").gradingScaleId).toBe(1));
  it("nothing usable -> null", () => expect(pickScale([scales[2]], "KG")).toBeNull());
});

const seed = () => {
  GradingScale.findAll.mockResolvedValue([
    { gradingScaleId: 1, name: "Primary (standard)", isDefault: true },
    { gradingScaleId: 2, name: "JHS (BECE 1-9)", isDefault: false },
  ]);
  GradeBand.findAll.mockResolvedValue([
    ...DEFAULT_PRIMARY_BANDS.map((b, i) => ({ ...b, gradeBandId: i + 1, gradingScaleId: 1, minScore: String(b.minScore) })),
    ...DEFAULT_JHS_BANDS.map((b, i) => ({ ...b, gradeBandId: i + 20, gradingScaleId: 2, minScore: String(b.minScore) })),
  ]);
  GradingScaleSection.findAll.mockResolvedValue([{ section: "JHS", gradingScaleId: 2 }]);
};

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe("makeGrader (used by every results save)", () => {
  it("grades by the class's section and reads the scales once per save", async () => {
    Class.findAll.mockImplementation(async ({ where }) => [{ section: where.where[1] === "jhs 2" ? "JHS" : "Lower Primary", isDeleted: false }]);
    const grade = makeGrader();
    expect(await grade(91, "JHS 2")).toEqual({ grade: "1", remark: "Excellent" });
    expect(await grade(36, "JHS 2")).toEqual({ grade: "8", remark: "Fail" });
    expect(await grade(36, " Basic 3 ")).toEqual({ grade: null, remark: "Fail" });
    expect(await grade(72.5, "BASIC 3")).toEqual({ grade: null, remark: "Very Good" });
    expect(GradingScale.findAll).toHaveBeenCalledTimes(1);
    expect(Class.findAll).toHaveBeenCalledTimes(2); // once per class
  });

  it("with no scales in the database it falls back to the built-in bands", async () => {
    GradingScale.findAll.mockResolvedValue([]);
    GradeBand.findAll.mockResolvedValue([]);
    GradingScaleSection.findAll.mockResolvedValue([]);
    Class.findAll.mockResolvedValue([{ section: "JHS", isDeleted: false }]);
    expect(await makeGrader()(55, "JHS 1")).toEqual({ grade: null, remark: "Credit" });
  });

  it("a live (not archived) class wins over an archived one with the same name", async () => {
    Class.findAll.mockResolvedValue([{ section: "Lower Primary", isDeleted: true }, { section: "JHS", isDeleted: false }]);
    expect((await makeGrader()(91, "JHS 1")).grade).toBe("1");
  });
});

describe("office edits (Administrator)", () => {
  const body = {
    name: "WAEC",
    isDefault: false,
    sections: ["Upper Primary", "upper primary", "JHS"],
    bands: [
      { grade: "A1", remark: "Excellent", minScore: 80, maxScore: 100 },
      { grade: "F9", remark: "Fail", minScore: 0, maxScore: 79.99 },
    ],
  };

  it("creates a scale in one transaction: bands sorted, sections deduplicated and moved off other scales", async () => {
    GradingScale.create.mockResolvedValue({ gradingScaleId: 3 });
    GradingScale.count.mockResolvedValue(1);
    await createScale(body);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(GradeBand.create.mock.calls.map((c) => c[0].grade)).toEqual(["F9", "A1"]);
    expect(GradingScaleSection.destroy).toHaveBeenCalledWith(expect.objectContaining({ where: { section: "JHS" } }));
    expect(GradingScaleSection.create.mock.calls.map((c) => c[0])).toEqual([
      { gradingScaleId: 3, section: "Upper Primary" },
      { gradingScaleId: 3, section: "JHS" },
    ]);
  });

  it("a duplicate name is refused (409), whatever the case", async () => {
    GradingScale.create.mockResolvedValue({ gradingScaleId: 3 });
    await expect(createScale({ ...body, name: "primary (STANDARD)" })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("making a scale the default clears the old default", async () => {
    GradingScale.findOne.mockResolvedValue({ gradingScaleId: 2 });
    GradingScale.count.mockResolvedValue(1);
    await updateScale(2, { ...body, name: "JHS (BECE 1-9)", isDefault: true });
    expect(GradingScale.update).toHaveBeenCalledWith({ isDefault: false }, expect.anything());
  });

  it("refuses to leave the school with no default scale", async () => {
    GradingScale.findOne.mockResolvedValue({ gradingScaleId: 1 });
    GradingScale.count.mockResolvedValue(0);
    await expect(updateScale(1, { ...body, name: "Primary (standard)", isDefault: false })).rejects.toThrow(/must be the default/);
  });

  it("bad bands are refused before anything is written", async () => {
    await expect(updateScale(2, { ...body, bands: [{ remark: "x", minScore: 5, maxScore: 100 }] })).rejects.toThrow(/start at 0/);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it("unknown scale = 404; the default scale can't be deleted", async () => {
    GradingScale.findOne.mockResolvedValue(null);
    await expect(updateScale(9, body)).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteScale(9)).rejects.toMatchObject({ statusCode: 404 });
    GradingScale.findOne.mockResolvedValue({ gradingScaleId: 1, isDefault: true });
    await expect(deleteScale(1)).rejects.toThrow(/default scale/);
    GradingScale.findOne.mockResolvedValue({ gradingScaleId: 2, isDefault: false });
    await expect(deleteScale(2)).resolves.toEqual({ deleted: 2 });
  });
});
