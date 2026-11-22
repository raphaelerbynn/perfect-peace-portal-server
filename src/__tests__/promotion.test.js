// B5: promotion rules (ported from SchoolPro's promotion.service.spec) and the
// service against an in-memory store. The transaction mock restores the store
// when the callback throws, the way a real rollback would.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn() } }));
jest.mock("../models/index.js", () => {
  const model = () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), bulkCreate: jest.fn(), update: jest.fn(), destroy: jest.fn() });
  return {
    __esModule: true,
    Class: model(),
    KgAssessment: model(),
    PromotionRule: model(),
    Student: model(),
    StudentPromotion: model(),
    StudentResult: model(),
    Term: model(),
  };
});

jest.mock("../services/attendance.js", () => ({ __esModule: true, assertClassAccess: jest.fn() }));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn(), startFeePeriod: jest.fn() }));

import sequelize from "../config/database.js";
import { assertClassAccess } from "../services/attendance.js";
import { recomputeStudentOwing, startFeePeriod } from "../services/fee.js";
import { AppError } from "../utils/errorHandling.js";
import { Class, KgAssessment, PromotionRule, Student, StudentPromotion, StudentResult, Term } from "../models/index.js";
import {
  acceptPromotion,
  decide,
  getPreview,
  getHistory,
  getStatus,
  planAccept,
  resolvePassMark,
  saveLadder,
  saveRules,
  validateLadder,
} from "../services/promotion.js";
import { officeUser } from "../testSupport/officeUser.js";

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------
describe("validateLadder", () => {
  const c = (classId, name, nextClassId = null, isAlumni = false) => ({ classId, name, nextClassId, isAlumni });
  it("accepts a straight ladder ending in an alumni class", () => {
    expect(validateLadder([c(1, "KG 1", 2), c(2, "KG 2", 3), c(3, "JHS 3", 9), c(9, "Graduated", null, true)])).toBe(true);
  });
  it("names the loop", () => {
    expect(() => validateLadder([c(1, "JHS 1", 2), c(2, "JHS 2", 3), c(3, "JHS 3", 1)])).toThrow(
      "The class order goes round in a circle: JHS 1 → JHS 2 → JHS 3 → JHS 1"
    );
  });
  it.each([
    [[c(1, "JHS 1", 1)], "JHS 1 can't move up into itself"],
    [[c(1, "JHS 1", 7)], "JHS 1's next class doesn't exist"],
    [[c(1, "Graduated", 2, true), c(2, "JHS 1")], "Graduated is an alumni class"],
  ])("refuses %o", (ladder, message) => {
    expect(() => validateLadder(ladder)).toThrow(message);
  });
});

it("pass mark: class rule beats the school rule, which beats the fallback (40)", () => {
  const rules = { defaultPassMark: 50, classRules: [{ classId: 3, passMark: 60 }] };
  expect(resolvePassMark(rules, 3)).toEqual({ passMark: 60, source: "class" });
  expect(resolvePassMark(rules, 4)).toEqual({ passMark: 50, source: "school" });
  expect(resolvePassMark({ defaultPassMark: null, classRules: [] }, 4)).toEqual({ passMark: 40, source: "fallback" });
});

describe("decide (one pupil)", () => {
  const klass = { classId: 1, name: "JHS 1" };
  const nextClass = { classId: 2, name: "JHS 2", isAlumni: false };
  const ctx = { klass, nextClass, kg: false, passMark: 50 };
  const pupil = (patch = {}) => ({ studentId: 7, name: "Abena", hasResult: true, rawScore: 600, totalRawScore: 1000, ...patch });

  it("promotes at or above the pass mark (exactly 50% passes)", () => {
    expect(decide(pupil({ rawScore: 500 }), ctx)).toMatchObject({ average: 50, computed: "PROMOTED", outcome: "PROMOTED", toClassId: 2, toClassName: "JHS 2", flags: [] });
  });
  it("repeats below it, staying in the class", () => {
    expect(decide(pupil({ rawScore: 499 }), ctx)).toMatchObject({ average: 49.9, outcome: "REPEATED", toClassId: 1, toClassName: "JHS 1" });
  });
  it("graduates when the next class is an alumni class", () => {
    const r = decide(pupil(), { ...ctx, nextClass: { classId: 9, name: "Graduated 2026", isAlumni: true } });
    expect(r).toMatchObject({ outcome: "GRADUATED", toClassName: "Graduated 2026" });
  });
  it("no result: flagged, defaults to repeating", () => {
    expect(decide(pupil({ hasResult: false }), ctx)).toMatchObject({ computed: null, outcome: "REPEATED", flags: ["NO_RESULT"] });
  });
  it("no next class: a pass is flagged NO_NEXT_CLASS with nowhere to go", () => {
    const r = decide(pupil(), { ...ctx, nextClass: null });
    expect(r).toMatchObject({ outcome: "PROMOTED", toClassId: null, flags: ["NO_NEXT_CLASS"] });
    // the teacher's "JHS 2" can't be judged without a next class: no extra flag
    expect(decide(pupil({ recommendation: "JHS 2" }), { ...ctx, nextClass: null }).flags).toEqual(["NO_NEXT_CLASS"]);
    expect(decide(pupil({ recommendation: "JHS 1" }), { ...ctx, nextClass: null }).flags).toEqual(["NO_NEXT_CLASS", "TEACHER_DISAGREES"]);
  });
  it("keeps a recorded override unless resetOverrides", () => {
    const existing = { outcome: "REPEATED", overridden: true, reason: "Missed most of term", fromClassId: 1, fromClassName: "JHS 1" };
    expect(decide(pupil({ existing }), ctx)).toMatchObject({ outcome: "REPEATED", overridden: true, reason: "Missed most of term", flags: ["OVERRIDDEN", "ALREADY_ACCEPTED"] });
    expect(decide(pupil({ existing }), ctx, { resetOverrides: true })).toMatchObject({ outcome: "PROMOTED", overridden: false, flags: ["ALREADY_ACCEPTED"] });
  });
  it("after the pupil has moved, the 'from' side stays frozen", () => {
    const existing = { outcome: "PROMOTED", overridden: false, fromClassId: 1, fromClassName: "JHS 1" };
    expect(decide(pupil({ existing }), ctx)).toMatchObject({ fromClassName: "JHS 1", toClassName: "JHS 2", alreadyAccepted: true });
  });
  it("flags a teacher recommendation that disagrees (case and spaces ignored)", () => {
    expect(decide(pupil({ recommendation: " jhs  2 " }), ctx).flags).toEqual([]);
    expect(decide(pupil({ recommendation: "JHS 1" }), ctx).flags).toEqual(["TEACHER_DISAGREES"]);
    expect(decide(pupil({ rawScore: 100, recommendation: "JHS 2" }), ctx).flags).toEqual(["TEACHER_DISAGREES"]);
  });
  it("KG: moves up unless the teacher kept them in their class", () => {
    const kgCtx = { klass: { classId: 5, name: "KG 1" }, nextClass: { classId: 6, name: "KG 2", isAlumni: false }, kg: true, passMark: 50 };
    expect(decide(pupil({ rawScore: null }), kgCtx)).toMatchObject({ average: null, outcome: "PROMOTED" });
    expect(decide(pupil({ recommendation: "KG 1" }), kgCtx)).toMatchObject({ outcome: "REPEATED" });
  });
});

describe("planAccept", () => {
  const preview = {
    class: { classId: 1, name: "JHS 1" },
    nextClass: { classId: 2, name: "JHS 2", isAlumni: false },
    rows: [
      { studentId: 7, name: "Abena", computed: "PROMOTED", fromClassId: 1, fromClassName: "JHS 1" },
      { studentId: 8, name: "Kofi", computed: null, fromClassId: 1, fromClassName: "JHS 1" },
    ],
  };
  it("accepts the computed outcome without a reason; no result + repeat is not an override", () => {
    const out = planAccept(preview, [{ studentId: 7, outcome: "PROMOTED" }, { studentId: 8, outcome: "repeated" }]);
    expect(out.map((p) => [p.studentId, p.outcome, p.overridden, p.toClassName])).toEqual([
      [7, "PROMOTED", false, "JHS 2"],
      [8, "REPEATED", false, "JHS 1"],
    ]);
  });
  it("an edited outcome needs a reason", () => {
    expect(() => planAccept(preview, [{ studentId: 7, outcome: "REPEATED" }])).toThrow("Give a reason for changing the outcome for Abena");
    expect(planAccept(preview, [{ studentId: 7, outcome: "REPEATED", reason: "Parent asked" }])[0]).toMatchObject({ overridden: true, reason: "Parent asked" });
  });
  it.each([
    [{ ...preview, nextClass: null }, [{ studentId: 7, outcome: "PROMOTED" }], "has no next class set"],
    [preview, [{ studentId: 7, outcome: "GRADUATED", reason: "xxx" }], "isn't an alumni class"],
    [{ ...preview, nextClass: { classId: 9, name: "Alumni", isAlumni: true } }, [{ studentId: 7, outcome: "PROMOTED", reason: "xxx" }], "graduates rather than moving up"],
    [preview, [{ studentId: 7, outcome: "PROMOTED" }, { studentId: 7, outcome: "PROMOTED" }], "appears twice"],
    [preview, [{ studentId: 99, outcome: "PROMOTED" }], "no longer part of this class"],
    [preview, [{ studentId: 7, outcome: "EXPELLED" }], "Pick promote, repeat or graduate"],
    [preview, [], "at least one decision"],
  ])("refuses bad payloads (%#)", (p, decisions, message) => {
    expect(() => planAccept(p, decisions)).toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// service, against an in-memory store
// ---------------------------------------------------------------------------
let store;
const matches = (row, where = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sym = Object.getOwnPropertySymbols(v)[0];
      const op = sym?.toString() || "";
      if (op.includes("ne")) return Number(row[k]) !== Number(v[sym]);
      if (op.includes("in")) return v[sym].map(Number).includes(Number(row[k]));
      if (op.includes("not")) return row[k] !== v[sym];
      return true;
    }
    return row[k] === v || (v != null && Number(row[k]) === Number(v) && !Number.isNaN(Number(v)));
  });
const orOk = (row, where = {}) => {
  const sym = Object.getOwnPropertySymbols(where).find((s) => s.toString().includes("or"));
  return sym ? where[sym].some((w) => matches(row, w)) : true;
};
const findIn = (key) => async ({ where } = {}) => store[key].filter((r) => matches(r, where) && orOk(r, where)).map((r) => ({ ...r }));
const findOneIn = (key) => async ({ where } = {}) => (await findIn(key)({ where }))[0] || null;
const updateIn = (key) => async (patch, { where }) => {
  let n = 0;
  store[key] = store[key].map((r) => (matches(r, where) && orOk(r, where) ? (n++, { ...r, ...patch }) : r));
  return [n];
};

beforeEach(() => {
  jest.resetAllMocks();
  store = {
    classes: [
      { classId: 1, name: "JHS 1", section: "JHS", nextClassId: 2, isAlumni: false, isDeleted: false },
      { classId: 2, name: "JHS 2", section: "JHS", nextClassId: 3, isAlumni: false, isDeleted: false },
      { classId: 3, name: "JHS 3", section: "JHS", nextClassId: 9, isAlumni: false, isDeleted: false },
      { classId: 9, name: "Graduated", section: "", nextClassId: null, isAlumni: true, isDeleted: false },
    ],
    terms: [{ termId: 30, term: "3", active: false }], // Term 3, closed: accept allowed
    students: [
      { studentId: 1, fName: "Abena", lName: "Boateng", classId: 1, class: "JHS 1", isDeleted: false },
      { studentId: 2, fName: "Kofi", lName: "Asare", classId: 1, class: "JHS 1", isDeleted: false },
      { studentId: 3, fName: "Yaw", lName: "Mensah", classId: 1, class: "JHS 1", isDeleted: false },
      { studentId: 4, fName: "Esi", lName: "Owusu", classId: 3, class: "JHS 3", isDeleted: false },
    ],
    results: [
      { studentId: 1, class: "JHS 1", termId: 30, rawScore: "700", totalRawScore: 1000, promotedTo: "JHS 2" },
      { studentId: 2, class: "JHS 1", termId: 30, rawScore: "300", totalRawScore: 1000, promotedTo: "JHS 2" },
      { studentId: 4, class: "JHS 3", termId: 30, rawScore: "800", totalRawScore: 1000, promotedTo: null },
    ],
    rules: [{ classId: null, passMark: "50.00" }],
    history: [],
  };
  sequelize.transaction.mockImplementation(async (cb) => {
    const snap = JSON.parse(JSON.stringify(store));
    try {
      return await cb({ LOCK: { UPDATE: "UPDATE" } });
    } catch (e) {
      store = snap;
      throw e;
    }
  });
  Class.findAll.mockImplementation(findIn("classes"));
  Class.findOne.mockImplementation(findOneIn("classes"));
  Class.update.mockImplementation(updateIn("classes"));
  Term.findOne.mockImplementation(findOneIn("terms"));
  Student.findAll.mockImplementation(findIn("students"));
  Student.update.mockImplementation(updateIn("students"));
  StudentResult.findAll.mockImplementation(findIn("results"));
  KgAssessment.findAll.mockResolvedValue([]);
  PromotionRule.findAll.mockImplementation(findIn("rules"));
  PromotionRule.destroy.mockImplementation(async () => {
    store.rules = [];
  });
  PromotionRule.bulkCreate.mockImplementation(async (rows) => store.rules.push(...rows));
  StudentPromotion.findAll.mockImplementation(findIn("history"));
  StudentPromotion.findOne.mockImplementation(findOneIn("history"));
  StudentPromotion.create.mockImplementation(async (row) => store.history.push({ ...row, studentPromotionId: store.history.length + 1 }));
  StudentPromotion.update.mockImplementation(updateIn("history"));
});

describe("getPreview", () => {
  it("computes outcomes against the school pass mark and writes nothing", async () => {
    const p = await getPreview({ classId: 1, termId: 30 });
    expect(p).toMatchObject({ passMark: 50, passMarkSource: "school", nextClass: { name: "JHS 2" } });
    expect(p.rows.map((r) => [r.name, r.average, r.outcome, r.flags])).toEqual([
      ["Abena Boateng", 70, "PROMOTED", []],
      ["Kofi Asare", 30, "REPEATED", ["TEACHER_DISAGREES"]], // teacher wrote JHS 2
      ["Yaw Mensah", null, "REPEATED", ["NO_RESULT"]],
    ]);
    expect(p.summary).toMatchObject({ total: 3, promoted: 1, repeated: 2, noResult: 1, teacherDisagrees: 1 });
    expect(p.warnings.map((w) => w.code)).toEqual(["NO_RESULT", "TEACHER_DISAGREES"]);
    expect(Student.update).not.toHaveBeenCalled();
    expect(StudentPromotion.create).not.toHaveBeenCalled();
  });

  it("the last class graduates into the alumni class", async () => {
    const p = await getPreview({ classId: 3, termId: 30 });
    expect(p.rows[0]).toMatchObject({ name: "Esi Owusu", outcome: "GRADUATED", toClassName: "Graduated" });
  });

  it("warns when it isn't term 3 or there's no next class", async () => {
    store.terms.push({ termId: 20, term: "2" });
    store.classes[0].nextClassId = null;
    const p = await getPreview({ classId: 1, termId: 20 });
    expect(p.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NO_NEXT_CLASS", "NOT_TERM_3"]));
  });
});

describe("acceptPromotion", () => {
  const decisions = [
    { studentId: 1, outcome: "PROMOTED" },
    { studentId: 2, outcome: "REPEATED" },
    { studentId: 3, outcome: "PROMOTED", reason: "Sat the exam late, passed" },
  ];

  it("moves pupils, records history with who and why", async () => {
    const out = await acceptPromotion({ classId: 1, termId: 30, decisions }, { decidedBy: "admin" });
    expect(out).toEqual({ moved: 2, recorded: 3, unchanged: 0, promoted: 2, repeated: 1, graduated: 0 });
    expect(store.students.filter((s) => s.classId === 2).map((s) => s.studentId)).toEqual([1, 3]);
    expect(store.students.find((s) => s.studentId === 1).class).toBe("JHS 2");
    expect(store.history.find((h) => h.studentId === 3)).toMatchObject({
      outcome: "PROMOTED", overridden: true, reason: "Sat the exam late, passed", fromClassName: "JHS 1", toClassName: "JHS 2", decidedBy: "admin", passMark: 50,
    });
    expect(store.history.find((h) => h.studentId === 1)).toMatchObject({ overridden: false, average: 70, teacherRecommendation: "JHS 2" });
    expect(Class.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "UPDATE" }));
  });

  it("fees: the first decision starts a new fee period; a later change only re-bills", async () => {
    await acceptPromotion({ classId: 1, termId: 30, decisions });
    expect(startFeePeriod.mock.calls.map(([id]) => id).sort()).toEqual([1, 2, 3]);
    expect(recomputeStudentOwing).toHaveBeenCalledTimes(3);
    jest.clearAllMocks();
    await acceptPromotion({ classId: 1, termId: 30, decisions: [{ studentId: 3, outcome: "REPEATED" }] });
    expect(startFeePeriod).not.toHaveBeenCalled(); // not a second new year
    expect(recomputeStudentOwing.mock.calls.map(([id]) => id)).toEqual([3]);
    // the period starts BEFORE the pupil is moved (arrears from the old class)
  });

  it("is idempotent: accepting again moves nobody twice", async () => {
    await acceptPromotion({ classId: 1, termId: 30, decisions });
    const again = await acceptPromotion({ classId: 1, termId: 30, decisions });
    expect(again).toMatchObject({ moved: 0, recorded: 0, unchanged: 3 });
    expect(store.history).toHaveLength(3);
  });

  it("changing a decision later moves the pupil back and updates the record", async () => {
    await acceptPromotion({ classId: 1, termId: 30, decisions });
    const out = await acceptPromotion({ classId: 1, termId: 30, decisions: [{ studentId: 3, outcome: "REPEATED" }] });
    expect(out).toMatchObject({ moved: 1, recorded: 1 });
    expect(store.students.find((s) => s.studentId === 3)).toMatchObject({ classId: 1, class: "JHS 1" });
    expect(store.history.filter((h) => h.studentId === 3)).toEqual([expect.objectContaining({ outcome: "REPEATED", overridden: false })]);
  });

  it("a bad decision rolls back the whole class", async () => {
    await expect(
      acceptPromotion({ classId: 1, termId: 30, decisions: [{ studentId: 1, outcome: "PROMOTED" }, { studentId: 2, outcome: "PROMOTED" }] })
    ).rejects.toMatchObject({ statusCode: 400, message: "Give a reason for changing the outcome for Kofi Asare" });
    expect(store.students.every((s) => s.classId !== 2)).toBe(true);
    expect(store.history).toEqual([]);
  });

  it("pupils promoted into the next class aren't decided again there (no double move)", async () => {
    await acceptPromotion({ classId: 1, termId: 30, decisions });
    store.students.push({ studentId: 5, fName: "Ama", lName: "Own", classId: 2, class: "JHS 2", isDeleted: false });
    const jhs2 = await getPreview({ classId: 2, termId: 30 });
    expect(jhs2.rows.map((r) => r.studentId)).toEqual([5]); // not Abena or Yaw, who arrived from JHS 1
    await expect(
      acceptPromotion({ classId: 2, termId: 30, decisions: [{ studentId: 1, outcome: "REPEATED" }] })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("no longer part of this class") });
    expect(store.students.find((s) => s.studentId === 1)).toMatchObject({ classId: 2 });
    const status = await getStatus({ termId: 30 });
    expect(status.classes.find((c) => c.name === "JHS 2")).toMatchObject({ pupils: 1, decided: 0, pending: 1 });
    expect(status.classes.find((c) => c.name === "JHS 1")).toMatchObject({ pupils: 3, decided: 3, pending: 0 });
  });

  it("refuses while Term 3 is open (409) and on other terms' results (400)", async () => {
    store.terms[0].active = true;
    await expect(acceptPromotion({ classId: 1, termId: 30, decisions })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("Close Term 3 first") });
    const open = await getPreview({ classId: 1, termId: 30 });
    expect(open.warnings.map((w) => w.code)).toContain("TERM_OPEN");
    store.terms.push({ termId: 20, term: "2", active: false });
    await expect(acceptPromotion({ classId: 1, termId: 20, decisions })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("Term 3") });
    expect(store.history).toEqual([]);
    expect(store.students.every((st) => st.classId !== 2)).toBe(true);
  });

  it("moves a legacy pupil whose classId is null (matched by class name)", async () => {
    store.students.push({ studentId: 6, fName: "Old", lName: "Record", classId: null, class: "JHS 1", isDeleted: false });
    store.results.push({ studentId: 6, class: "JHS 1", termId: 30, rawScore: "900", totalRawScore: 1000 });
    const before = await getStatus({ termId: 30 });
    expect(before.classes.find((c) => c.name === "JHS 1").pending).toBe(4); // counted by name
    const out = await acceptPromotion({ classId: 1, termId: 30, decisions: [{ studentId: 6, outcome: "PROMOTED" }] });
    expect(out.moved).toBe(1);
    expect(store.students.find((st) => st.studentId === 6)).toMatchObject({ classId: 2, class: "JHS 2" });
  });

  it("graduates the last class into the alumni class", async () => {
    await acceptPromotion({ classId: 3, termId: 30, decisions: [{ studentId: 4, outcome: "GRADUATED" }] });
    expect(store.students.find((s) => s.studentId === 4)).toMatchObject({ classId: 9, class: "Graduated" });
  });
});

it("saveLadder checks the whole ladder and rolls back on a loop", async () => {
  await expect(saveLadder([{ classId: 3, nextClassId: 1 }])).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("circle") });
  expect(store.classes.find((c) => c.classId === 3).nextClassId).toBe(9);
  await saveLadder([{ classId: 3, nextClassId: "" }, { classId: 9, isAlumni: false }]);
  expect(store.classes.find((c) => c.classId === 3).nextClassId).toBeNull();
});

it("saveRules replaces all pass marks and validates them", async () => {
  const out = await saveRules({ defaultPassMark: "45", classRules: [{ classId: 3, passMark: 55 }] }, { updatedBy: "admin" });
  expect(out).toEqual({ defaultPassMark: 45, fallbackPassMark: 40, classRules: [{ classId: 3, passMark: 55 }] });
  await expect(saveRules({ defaultPassMark: 101 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(saveRules({ defaultPassMark: 50, classRules: [{ classId: 3, passMark: 50 }, { classId: 3, passMark: 60 }] })).rejects.toMatchObject({ statusCode: 400 });
  expect(store.rules).toHaveLength(2); // unchanged by the failed saves
});

it("getStatus counts pupils still waiting for a decision per class", async () => {
  await acceptPromotion({ classId: 1, termId: 30, decisions: [{ studentId: 1, outcome: "PROMOTED" }] });
  const s = await getStatus({ termId: 30 });
  const jhs1 = s.classes.find((c) => c.name === "JHS 1");
  expect(jhs1).toMatchObject({ pupils: 3, decided: 1, pending: 2 }); // Abena counts for JHS 1, where she was decided
  expect(s.classes.find((c) => c.name === "Graduated")).toBeUndefined();
  expect(s.pendingClasses).toBe(2); // JHS 1 and JHS 3
});

describe("getHistory scope", () => {
  beforeEach(() => {
    Student.findOne.mockResolvedValue({ class: "JHS 1" });
    StudentPromotion.findAll.mockResolvedValue([]);
  });
  it("Administrator: any pupil", async () => {
    await getHistory(1, officeUser("Administrator"));
    expect(assertClassAccess).not.toHaveBeenCalled();
  });
  it("Class Teacher: own pupils only", async () => {
    assertClassAccess.mockRejectedValueOnce(new AppError("nope", 403));
    const ct = officeUser("Class Teacher", { teacherId: 9 });
    await expect(getHistory(1, ct)).rejects.toMatchObject({ statusCode: 403 });
    expect(assertClassAccess).toHaveBeenCalledWith(ct, "JHS 1");
  });
});

describe("Term 3 already promoted by the old system (migration 028)", () => {
  beforeEach(() => {
    store.terms.push({ termId: 14, term: "3", active: false, promotedByOldSystem: true });
  });
  it("the preview says so and accept is refused, so nobody moves or is billed twice", async () => {
    const p = await getPreview({ classId: 1, termId: 14 });
    expect(p.term.promotedByOldSystem).toBe(true);
    expect(p.warnings.map((w) => w.code)).toContain("PROMOTED_BY_OLD_SYSTEM");
    await expect(
      acceptPromotion({ classId: 1, termId: 14, decisions: [{ studentId: 1, outcome: "PROMOTED" }] })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(startFeePeriod).not.toHaveBeenCalled();
  });
  it("status shows nothing waiting for that term", async () => {
    const s = await getStatus({ termId: 14 });
    expect(s.pendingClasses).toBe(0);
    expect(s.term.promotedByOldSystem).toBe(true);
    expect(s.classes.every((c) => c.pending === 0)).toBe(true);
  });
});
