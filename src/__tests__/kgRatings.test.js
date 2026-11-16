// B2: KG / nursery development ratings from the teacher portal
// (GET/POST /teacher/kg-ratings). Models mocked; the scope rule runs for real.
jest.mock("../models/index.js", () => ({
  __esModule: true,
  TeachingAssignment: { findAll: jest.fn() },
  Class: { findAll: jest.fn(), findOne: jest.fn() },
  Subject: { findAll: jest.fn(), findOne: jest.fn() },
  Teacher: { findOne: jest.fn(), count: jest.fn() },
  Student: { findAll: jest.fn() },
  Attendance: { findAll: jest.fn(), count: jest.fn() },
  StudentMarks: { findAll: jest.fn() },
  KgAssessment: { findAll: jest.fn(), findOne: jest.fn(), update: jest.fn(), create: jest.fn(), destroy: jest.fn() },
}));
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn() } }));
jest.mock("../services/attendance.js", () => ({ __esModule: true, VALID_STATUSES: ["Present"], markClassAttendance: jest.fn() }));
jest.mock("../services/results.js", () => ({ __esModule: true, saveClassSubjectScores: jest.fn() }));
jest.mock("../services/term.js", () => ({ __esModule: true, requireActiveTerm: jest.fn() }));
jest.mock("../services/grading.js", () => ({ __esModule: true, bandsForSection: jest.fn() }));

import { Attendance, Class, KgAssessment, Student, StudentMarks, Subject, Teacher, TeachingAssignment } from "../models/index.js";
import sequelize from "../config/database.js";
import { requireActiveTerm } from "../services/term.js";
import { getKgRatings, getMyClasses, saveKgRatings } from "../services/teacherTools.js";
import { KG_RATING_ITEM_COUNT, KG_RATING_SECTIONS } from "../utils/kgRatings.js";
import { AppError } from "../utils/errorHandling.js";

// KG 1 (3): class teacher Ama (10). JHS 1 (1): class teacher Ama too.
// Kofi (11) teaches nothing in KG 1.
const TERM = { termId: 5, term: "1", startDate: "2026-09-01", endDate: "2026-12-18", active: true };
const classes = {
  1: { classId: 1, name: "JHS 1", section: "JHS", teacherId: 10 },
  3: { classId: 3, name: "KG 1", section: "KG", teacherId: 10 },
};
const teachers = { 10: { teacherId: 10, fName: "Ama", lName: "Owusu" }, 11: { teacherId: 11, fName: "Kofi", lName: "Mensah" } };
const roster = [
  { studentId: 1, fName: "Abena", lName: "Boateng" },
  { studentId: 2, fName: "Yaw", lName: "Asare" },
];
const LANG = "Language Development (Reading, Listening and Oral Skills)";
const LANG_UP = LANG.toUpperCase();
const PHYS = "Physical Development";

const matches = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object") return Object.getOwnPropertySymbols(v).every((sym) => v[sym].includes(row[k]));
    return row[k] === v;
  });

beforeEach(() => {
  jest.resetAllMocks();
  requireActiveTerm.mockResolvedValue(TERM);
  Teacher.findOne.mockImplementation(async ({ where }) => teachers[where.teacherId] || null);
  Class.findOne.mockImplementation(async ({ where }) => classes[where.classId] || null);
  Class.findAll.mockImplementation(async ({ where }) => Object.values(classes).filter((c) => matches({ ...c, isDeleted: false }, where)));
  TeachingAssignment.findAll.mockResolvedValue([]);
  Subject.findAll.mockResolvedValue([]);
  Student.findAll.mockResolvedValue(roster);
  Attendance.count.mockResolvedValue(0);
  StudentMarks.findAll.mockResolvedValue([]);
  KgAssessment.findAll.mockResolvedValue([]);
  sequelize.transaction.mockImplementation(async (cb) => cb({ id: "t1" }));
});

const flags = (on) => ({
  satisfactory: on === "satisfactory" ? 1 : 0,
  improved: on === "improved" ? 1 : 0,
  needsImprovement: on === "needs_improvement" ? 1 : 0,
  unsatisfactory: on === "unsatisfactory" ? 1 : 0,
  notApplicable: on === "not_applicable" ? 1 : 0,
});

describe("the list", () => {
  it("has the office form's four sections and 30 items, spelled as stored", () => {
    expect(KG_RATING_SECTIONS.map((s) => s.category)).toEqual([
      LANG,
      "Personal / Social / Emotional Development",
      PHYS,
      "Cognitive Development (Position, Direction, Thinking)",
    ]);
    expect(KG_RATING_ITEM_COUNT).toBe(30);
    // The report card's existing rows use these exact (misspelt) strings.
    expect(KG_RATING_SECTIONS[0].items).toContain("Identifying rything words");
    expect(KG_RATING_SECTIONS[2].items[0]).toBe("Demonstatrate basic locomotor abilities (running, jumping, hoppinh, catching, etc)");
  });
});

describe("GET /teacher/kg-ratings", () => {
  it("the class teacher sees the sections, the class's progress and one pupil's ratings", async () => {
    KgAssessment.findAll.mockResolvedValue([
      { studentId: 1, category: LANG_UP, assessment: "Participate in conversation", ...flags("improved") },
      { studentId: 1, category: LANG_UP, assessment: "Forms simple sentence", ...flags(null) }, // no flag = unrated
      { studentId: 1, category: LANG_UP, assessment: "Not on the list any more", ...flags("satisfactory") },
      { studentId: 2, category: PHYS.toUpperCase(), assessment: "Shows balance while moving", ...flags("satisfactory") },
    ]);
    const out = await getKgRatings(10, { classId: "3", studentId: "1" });

    const where = KgAssessment.findAll.mock.calls[0][0].where;
    expect(where).toMatchObject({ class: "KG 1", termId: 5 });
    const cats = Object.getOwnPropertySymbols(where.category).map((s) => where.category[s])[0];
    expect(cats).toHaveLength(4);
    expect(cats).not.toContain("ACADEMIC PROGRESS/EXAMINATION SCORES");

    expect(out.sections).toHaveLength(4);
    expect(out.ratings.map((r) => r.value)).toEqual(["satisfactory", "improved", "needs_improvement", "unsatisfactory", "not_applicable"]);
    expect(out.students).toEqual([
      expect.objectContaining({ studentId: 1, name: "Abena Boateng", rated: 1, total: 30, complete: false }),
      expect.objectContaining({ studentId: 2, rated: 1, complete: false }),
    ]);
    expect(out.pupil).toMatchObject({ studentId: 1, rated: 1, complete: false });
    expect(out.pupil.ratings[LANG]["Participate in conversation"]).toBe("improved");
    expect(out.pupil.ratings[LANG]["Forms simple sentence"]).toBeNull();
    expect(Object.keys(out.pupil.ratings[PHYS])).toHaveLength(5);
  });

  it("a pupil with every item rated is complete", async () => {
    KgAssessment.findAll.mockResolvedValue(
      KG_RATING_SECTIONS.flatMap((s) =>
        s.items.map((assessment) => ({ studentId: 2, category: s.category.toUpperCase(), assessment, ...flags("not_applicable") }))
      )
    );
    const out = await getKgRatings(10, { classId: 3 });
    expect(out.pupil).toBeNull();
    expect(out.students[1]).toMatchObject({ studentId: 2, rated: 30, complete: true });
  });

  it("refuses a teacher who isn't the class teacher (403)", async () => {
    await expect(getKgRatings(11, { classId: 3 })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a primary / JHS class (400)", async () => {
    await expect(getKgRatings(10, { classId: 1 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/KG \/ nursery classes only/),
    });
  });

  it("refuses a pupil who isn't in the class (400)", async () => {
    await expect(getKgRatings(10, { classId: 3, studentId: 99 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/not in this class/),
    });
  });

  it("an archived staff account is refused (403)", async () => {
    await expect(getKgRatings(77, { classId: 3 })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("POST /teacher/kg-ratings", () => {
  const body = (ratings, extra = {}) => ({ classId: 3, studentId: 1, ratings, ...extra });

  it("upserts on the office key, in report-card order, in one transaction; blanks are skipped", async () => {
    KgAssessment.findOne.mockImplementation(async ({ where }) =>
      where.assessment === "Shows balance while moving" ? { kgAssessmentId: 41 } : null
    );
    const out = await saveKgRatings(
      10,
      body({
        [PHYS]: { "Shows balance while moving": "needs_improvement", "Fit small things together": "" },
        [LANG]: { "Participate in conversation": "satisfactory", "Interested in reading": null },
      })
    );
    expect(out.saved).toBe(2);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);

    // Language first (report-card order), created with the upper-cased category.
    expect(KgAssessment.findOne.mock.calls[0][0]).toEqual({
      where: { studentId: 1, class: "KG 1", termId: 5, category: LANG_UP, assessment: "Participate in conversation" },
      transaction: { id: "t1" },
    });
    expect(KgAssessment.create).toHaveBeenCalledTimes(1);
    expect(KgAssessment.create.mock.calls[0][0]).toMatchObject({
      studentId: 1, class: "KG 1", termId: 5, category: LANG_UP, assessment: "Participate in conversation",
      term: "1", ...flags("satisfactory"),
    });
    expect(KgAssessment.create.mock.calls[0][1]).toEqual({ transaction: { id: "t1" } });

    // Existing row: only the flags (+ term, date) change; scores and promoted are left alone.
    expect(KgAssessment.update).toHaveBeenCalledTimes(1);
    const [values, opts] = KgAssessment.update.mock.calls[0];
    expect(opts).toEqual({ where: { kgAssessmentId: 41 }, transaction: { id: "t1" } });
    expect(values).toMatchObject({ term: "1", ...flags("needs_improvement") });
    expect(Object.keys(values).sort()).toEqual(
      ["date", "improved", "needsImprovement", "notApplicable", "satisfactory", "term", "unsatisfactory"]
    );

    expect(KgAssessment.destroy).not.toHaveBeenCalled();
    expect(out.sheet.pupil).toMatchObject({ studentId: 1 });
  });

  it("takes the section key or the stored upper-case name too", async () => {
    KgAssessment.findOne.mockResolvedValue(null);
    await expect(
      saveKgRatings(10, body({ physicalDevelopment: { "Shows interest in writing": "improved" }, [LANG_UP]: { "Listens to short story": "improved" } }))
    ).resolves.toMatchObject({ saved: 2 });
  });

  it("never touches Academic Progress rows", async () => {
    await expect(
      saveKgRatings(10, body({ "Academic Progress/Examination Scores": { Numeracy: "satisfactory" } }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(KgAssessment.create).not.toHaveBeenCalled();
    expect(KgAssessment.update).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown section", { "Music Development": { Sings: "satisfactory" } }, /not a development section/],
    ["an unknown item", { [LANG]: { "Speaks French": "satisfactory" } }, /not on the Language Development/],
    ["an unknown rating", { [LANG]: { "Participate in conversation": "excellent" } }, /Invalid rating "excellent"/],
    ["a section that isn't an object", { [LANG]: "satisfactory" }, /must be an object/],
    ["nothing rated", { [LANG]: { "Participate in conversation": "" } }, /Nothing to save/],
  ])("refuses %s (400)", async (_l, ratings, msg) => {
    await expect(saveKgRatings(10, body(ratings))).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(msg) });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it("refuses ratings that aren't an object (400)", async () => {
    await expect(saveKgRatings(10, body(undefined))).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveKgRatings(10, body([]))).rejects.toMatchObject({ statusCode: 400 });
  });

  const ok = { [LANG]: { "Participate in conversation": "satisfactory" } };

  it("refuses a teacher who isn't the class teacher (403), a JHS class (400), a pupil from elsewhere (400)", async () => {
    await expect(saveKgRatings(11, body(ok))).rejects.toMatchObject({ statusCode: 403 });
    await expect(saveKgRatings(10, body(ok, { classId: 1 }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveKgRatings(10, body(ok, { studentId: 99 }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/not in this class/),
    });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it("no open term (closed term): 409, nothing written", async () => {
    requireActiveTerm.mockRejectedValue(new AppError("No term is open", 409));
    await expect(saveKgRatings(10, body(ok))).rejects.toMatchObject({ statusCode: 409 });
    await expect(getKgRatings(10, { classId: 3 })).rejects.toMatchObject({ statusCode: 409 });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});

describe("my classes", () => {
  it("a KG class teacher sees how many pupils have every rating in", async () => {
    KgAssessment.findAll.mockImplementation(async ({ where }) =>
      where.category?.constructor === Object && Object.getOwnPropertySymbols(where.category).length
        ? KG_RATING_SECTIONS.flatMap((s) =>
            s.items.map((assessment) => ({ studentId: 1, category: s.category.toUpperCase(), assessment, ...flags("improved") }))
          )
        : []
    );
    const out = await getMyClasses(10);
    expect(out.classes.find((c) => c.name === "KG 1").kgRatings).toEqual({ complete: 1, pupils: 2 });
    expect(out.classes.find((c) => c.name === "JHS 1").kgRatings).toBeUndefined();
  });
});
