// B3: timetable rules (ported from SchoolPro) and the service, with models
// replaced by a small in-memory store. The transaction mock runs the callback
// and, if it throws, restores the store, the way a real rollback would.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(), query: jest.fn() } }));
jest.mock("../models/index.js", () => {
  const model = () => ({
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    bulkCreate: jest.fn(),
    update: jest.fn(),
    destroy: jest.fn(),
  });
  return {
    __esModule: true,
    Class: model(),
    Student: model(),
    Subject: model(),
    Teacher: model(),
    TeachingAssignment: model(),
    TimetableEntry: model(),
    TimetablePeriod: model(),
    Term: model(),
  };
});

import sequelize from "../config/database.js";
import {
  Class,
  Student,
  Subject,
  Teacher,
  TeachingAssignment,
  TimetableEntry,
  TimetablePeriod,
  Term,
} from "../models/index.js";
import {
  bulkCreateEntries,
  classClashMessage,
  copyTimetable,
  createEntry,
  findClassClashes,
  findTeacherClashes,
  getPortalTimetable,
  normaliseEntry,
  overlaps,
  planAssignmentSync,
  replacePeriods,
  syncAssignmentsFromTimetable,
  teacherClashWarning,
  to12Hour,
  updateEntry,
  validatePeriods,
} from "../services/timetable.js";

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------
describe("overlap (SchoolPro: !(newEnd <= start || newStart >= end))", () => {
  const slot = { startTime: "08:00", endTime: "08:40" };
  it.each([
    ["same slot", "08:00", "08:40", true],
    ["starts inside", "08:20", "09:00", true],
    ["ends inside", "07:30", "08:10", true],
    ["covers it", "07:00", "10:00", true],
    ["inside it", "08:10", "08:30", true],
    ["back to back after", "08:40", "09:20", false],
    ["back to back before", "07:20", "08:00", false],
    ["later", "10:00", "10:40", false],
  ])("%s", (_name, startTime, endTime, expected) => {
    expect(overlaps(slot, { startTime, endTime })).toBe(expected);
  });
});

it("formats times on a 12-hour clock", () => {
  expect(to12Hour("08:05")).toBe("8:05 AM");
  expect(to12Hour("12:00")).toBe("12:00 PM");
  expect(to12Hour("00:30")).toBe("12:30 AM");
  expect(to12Hour("13:40")).toBe("1:40 PM");
});

describe("normaliseEntry", () => {
  const ok = { termId: 2, classId: 1, subjectId: 3, teacherId: 4, day: 1, startTime: "08:00", endTime: "08:40" };
  it("accepts a lesson and trims room/notes", () => {
    expect(normaliseEntry({ ...ok, room: "  Lab ", notes: "" })).toEqual({ ...ok, room: "Lab", notes: null });
  });
  it.each([
    [{ day: 0 }, "Pick a school day"],
    [{ day: 6 }, "Pick a school day"],
    [{ startTime: "8:00" }, "like 08:00"],
    [{ endTime: "24:00" }, "like 08:00"],
    [{ startTime: "09:00", endTime: "09:00" }, "must end after it starts"],
    [{ startTime: "10:00", endTime: "09:00" }, "must end after it starts"],
    [{ subjectId: "" }, "Subject is required"],
    [{ teacherId: null }, "Teacher is required"],
    [{ room: "x".repeat(51) }, "Room must be 50"],
  ])("rejects %o", (patch, message) => {
    expect(() => normaliseEntry({ ...ok, ...patch })).toThrow(message);
  });
});

describe("clash matrix", () => {
  const entry = { termId: 2, classId: 1, teacherId: 7, day: 1, startTime: "08:00", endTime: "08:40" };
  const base = { timetableEntryId: 50, termId: 2, classId: 1, teacherId: 9, day: 1, startTime: "08:20", endTime: "09:00" };
  it.each([
    ["same class, overlapping", {}, 1, 0],
    ["same class, other day", { day: 2 }, 0, 0],
    ["same class, other term", { termId: 3 }, 0, 0],
    ["same class, back to back", { startTime: "08:40", endTime: "09:20" }, 0, 0],
    ["other class, same teacher", { classId: 2, teacherId: 7 }, 0, 1],
    ["same class and teacher", { teacherId: 7 }, 1, 1],
    ["other class, other teacher", { classId: 2 }, 0, 0],
  ])("%s", (_n, patch, classHits, teacherHits) => {
    const existing = [{ ...base, ...patch }];
    expect(findClassClashes(entry, existing)).toHaveLength(classHits);
    expect(findTeacherClashes(entry, existing)).toHaveLength(teacherHits);
  });
  it("ignores the lesson being edited", () => {
    expect(findClassClashes(entry, [base], 50)).toHaveLength(0);
    expect(findTeacherClashes(entry, [{ ...base, teacherId: 7 }], "50")).toHaveLength(0);
  });
});

it("writes clash messages a person can act on", () => {
  const entry = { day: 2 };
  const c = { subjectName: "Maths", className: "JHS 2", teacherName: "Esi Asante", startTime: "08:00", endTime: "08:40" };
  expect(classClashMessage("JHS 1", entry, [c])).toBe(
    "JHS 1 already has Maths with Esi Asante at 8:00 AM–8:40 AM on Tuesday. Pick a free slot or change that lesson."
  );
  expect(teacherClashWarning("Esi Asante", entry, [c])).toBe(
    "Esi Asante is also teaching Maths in JHS 2 at 8:00 AM–8:40 AM on Tuesday. Saved anyway; check this is right."
  );
});

describe("validatePeriods", () => {
  it("sorts by start time and numbers them", () => {
    const out = validatePeriods([
      { label: "Period 2", startTime: "08:40", endTime: "09:20" },
      { label: "Period 1", startTime: "08:00", endTime: "08:40" },
      { label: "Break", startTime: "09:20", endTime: "09:50", isBreak: true },
    ]);
    expect(out.map((p) => [p.label, p.sortOrder, p.isBreak])).toEqual([
      ["Period 1", 1, false],
      ["Period 2", 2, false],
      ["Break", 3, true],
    ]);
  });
  it("rejects overlapping periods, naming both", () => {
    expect(() =>
      validatePeriods([
        { label: "Period 1", startTime: "08:00", endTime: "08:45" },
        { label: "Period 2", startTime: "08:40", endTime: "09:20" },
      ])
    ).toThrow("Period 1 (8:00 AM–8:45 AM) overlaps Period 2 (8:40 AM–9:20 AM)");
  });
  it("needs a name and valid times", () => {
    expect(() => validatePeriods([{ label: " ", startTime: "08:00", endTime: "08:40" }])).toThrow("Row 1 needs a name");
    expect(() => validatePeriods([{ label: "P1", startTime: "09:00", endTime: "08:00" }])).toThrow(
      "P1 must end after it starts"
    );
    expect(() => validatePeriods("nope")).toThrow("periods must be a list");
  });
});

describe("planAssignmentSync (timetable -> B2 subject teachers)", () => {
  const e = (classId, subjectId, teacherId, teacherName = `T${teacherId}`) => ({
    classId,
    subjectId,
    teacherId,
    teacherName,
    className: `C${classId}`,
    subjectName: `S${subjectId}`,
  });
  const classTeachers = new Map([[1, 10]]);
  it("assigns a single subject teacher, skips what already matches", () => {
    const plan = planAssignmentSync(
      [e(1, 100, 11), e(1, 100, 11), e(1, 101, 10), e(1, 102, 12)],
      [{ classId: 1, subjectId: 102, teacherId: 12 }],
      classTeachers
    );
    expect(plan.set).toEqual([{ classId: 1, subjectId: 100, teacherId: 11 }]);
    expect(plan.unchanged).toBe(2); // the class teacher's own subject + 102 already right
    expect(plan.conflicts).toEqual([]);
  });
  it("replaces a different assignment, even with the class teacher", () => {
    const plan = planAssignmentSync([e(1, 100, 10)], [{ classId: 1, subjectId: 100, teacherId: 11 }], classTeachers);
    expect(plan.set).toEqual([{ classId: 1, subjectId: 100, teacherId: 10 }]);
  });
  it("reports a subject with two teachers instead of guessing", () => {
    const plan = planAssignmentSync([e(1, 100, 11, "Kofi"), e(1, 100, 12, "Esi")], [], classTeachers);
    expect(plan.set).toEqual([]);
    expect(plan.conflicts).toEqual([{ className: "C1", subjectName: "S100", teachers: ["Kofi", "Esi"] }]);
  });
});

// ---------------------------------------------------------------------------
// service, against an in-memory store
// ---------------------------------------------------------------------------
const CLASSES = [
  { classId: 1, name: "JHS 1", teacherId: 10, isDeleted: false },
  { classId: 2, name: "JHS 2", teacherId: 11, isDeleted: false },
];
const SUBJECTS = [
  { subjectId: 100, name: "Maths", isDeleted: false },
  { subjectId: 101, name: "English", isDeleted: false },
  { subjectId: 102, name: "French", isDeleted: true },
];
const TEACHERS = [
  { teacherId: 10, fName: "Ama", lName: "Owusu", isDeleted: false },
  { teacherId: 11, fName: "Kofi", lName: "Mensah", isDeleted: false },
  { teacherId: 12, fName: "Old", lName: "Hand", isDeleted: true },
];
const TERMS = [
  { termId: 2, term: "1", active: true },
  { termId: 3, term: "2", active: false },
];

let store;
let nextId;
const matches = (row, where = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) return true; // Op.or etc.: filtered below
    return row[k] === v || Number(row[k]) === Number(v);
  });
const orFilter = (row, where = {}) => {
  const sym = Object.getOwnPropertySymbols(where)[0];
  return sym ? where[sym].some((w) => matches(row, w)) : true;
};
const withRefs = (e) => ({
  ...e,
  class: CLASSES.find((c) => c.classId === e.classId),
  subject: SUBJECTS.find((s) => s.subjectId === e.subjectId),
  teacher: TEACHERS.find((t) => t.teacherId === e.teacherId),
});
const lookup = (rows) => async ({ where }) => rows.find((r) => matches(r, where)) || null;

beforeEach(() => {
  jest.resetAllMocks();
  store = { entries: [], periods: [], assignments: [] };
  nextId = 1;
  sequelize.transaction.mockImplementation(async (cb) => {
    const snapshot = JSON.parse(JSON.stringify(store));
    try {
      return await cb({ LOCK: { UPDATE: "UPDATE" } });
    } catch (e) {
      store = snapshot;
      throw e;
    }
  });
  Class.findOne.mockImplementation(lookup(CLASSES));
  Class.findAll.mockResolvedValue(CLASSES);
  Subject.findOne.mockImplementation(lookup(SUBJECTS));
  Subject.findAll.mockImplementation(async ({ where }) => SUBJECTS.filter((s) => matches(s, where)));
  Teacher.findOne.mockImplementation(lookup(TEACHERS));
  Term.findOne.mockImplementation(lookup(TERMS));
  TimetableEntry.findAll.mockImplementation(async ({ where }) =>
    store.entries.filter((e) => matches(e, where) && orFilter(e, where)).map(withRefs)
  );
  TimetableEntry.findOne.mockImplementation(async ({ where }) => {
    const row = store.entries.find((e) => matches(e, where));
    return row ? withRefs(row) : null;
  });
  TimetableEntry.create.mockImplementation(async (row) => {
    const saved = { ...row, timetableEntryId: nextId++ };
    store.entries.push(saved);
    return saved;
  });
  TimetableEntry.bulkCreate.mockImplementation(async (rows) =>
    rows.forEach((r) => store.entries.push({ ...r, timetableEntryId: nextId++ }))
  );
  TimetableEntry.update.mockImplementation(async (patch, { where }) => {
    store.entries = store.entries.map((e) => (matches(e, where) ? { ...e, ...patch } : e));
  });
  TimetablePeriod.destroy.mockImplementation(async () => {
    store.periods = [];
  });
  TimetablePeriod.bulkCreate.mockImplementation(async (rows) => store.periods.push(...rows));
  TimetablePeriod.findAll.mockImplementation(async () => store.periods);
  TeachingAssignment.findAll.mockImplementation(async () => store.assignments);
  TeachingAssignment.findOne.mockImplementation(async ({ where }) => store.assignments.find((a) => matches(a, where)) || null);
  TeachingAssignment.create.mockImplementation(async (row) => store.assignments.push({ ...row, teachingAssignmentId: nextId++ }));
  TeachingAssignment.update.mockImplementation(async (patch, { where }) => {
    store.assignments = store.assignments.map((a) => (matches(a, where) ? { ...a, ...patch } : a));
  });
});

const lesson = (patch = {}) => ({
  termId: 2,
  classId: 1,
  subjectId: 100,
  teacherId: 11,
  day: 1,
  startTime: "08:00",
  endTime: "08:40",
  ...patch,
});

describe("createEntry", () => {
  it("saves a lesson with names and no warnings", async () => {
    const out = await createEntry(lesson({ room: "Room 4" }), { createdBy: "admin" });
    expect(out.warnings).toEqual([]);
    expect(out.entry).toMatchObject({
      className: "JHS 1",
      subjectName: "Maths",
      teacherName: "Kofi Mensah",
      room: "Room 4",
      createdBy: "admin",
    });
    expect(Class.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: "UPDATE" })); // class row locked
  });

  it("refuses a class clash (409) and saves nothing", async () => {
    await createEntry(lesson());
    await expect(createEntry(lesson({ subjectId: 101, teacherId: 10, startTime: "08:20", endTime: "09:00" }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("JHS 1 already has Maths with Kofi Mensah at 8:00 AM–8:40 AM on Monday"),
    });
    expect(store.entries).toHaveLength(1);
  });

  it("saves a teacher double-booking with a warning", async () => {
    await createEntry(lesson());
    const out = await createEntry(lesson({ classId: 2, subjectId: 101 }));
    expect(store.entries).toHaveLength(2);
    expect(out.warnings).toEqual([
      "Kofi Mensah is also teaching Maths in JHS 1 at 8:00 AM–8:40 AM on Monday. Saved anyway; check this is right.",
    ]);
  });

  it.each([
    [{ classId: 9 }, "Class not found"],
    [{ subjectId: 102 }, "Subject not found"], // archived
    [{ teacherId: 12 }, "Teacher not found"], // archived
    [{ termId: 9 }, "Term not found"],
  ])("404 for missing or archived references %o", async (patch, message) => {
    await expect(createEntry(lesson(patch))).rejects.toMatchObject({ statusCode: 404, message });
  });
});

describe("updateEntry", () => {
  it("moves a lesson, ignoring its own old slot, and keeps term and class", async () => {
    const { entry } = await createEntry(lesson());
    const out = await updateEntry(entry.timetableEntryId, { startTime: "08:20", endTime: "09:00", classId: 2, termId: 3 });
    expect(out.entry).toMatchObject({ startTime: "08:20", endTime: "09:00", classId: 1, termId: 2 });
  });
  it("refuses moving onto another lesson of the class", async () => {
    const { entry } = await createEntry(lesson());
    await createEntry(lesson({ subjectId: 101, startTime: "09:00", endTime: "09:40" }));
    await expect(updateEntry(entry.timetableEntryId, { startTime: "09:00", endTime: "09:40" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("404 for an unknown lesson", async () => {
    await expect(updateEntry(99, {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("bulkCreateEntries (one transaction)", () => {
  it("saves every row and collects teacher warnings by row", async () => {
    const out = await bulkCreateEntries([lesson(), lesson({ classId: 2, subjectId: 101 })]);
    expect(out.created).toBe(2);
    expect(out.warnings).toEqual([expect.stringMatching(/^Row 2: Kofi Mensah is also teaching Maths in JHS 1/)]);
  });
  it("rolls back everything when a later row clashes with an earlier one", async () => {
    await expect(
      bulkCreateEntries([lesson(), lesson({ day: 2 }), lesson({ subjectId: 101, startTime: "08:30", endTime: "09:10" })])
    ).rejects.toMatchObject({
      statusCode: 409,
      // each clashing lesson named once (earlier batch rows are not double-counted)
      message: "Row 3: JHS 1 already has Maths with Kofi Mensah at 8:00 AM–8:40 AM on Monday. Pick a free slot or change that lesson.",
    });
    expect(store.entries).toEqual([]);
  });
  it("rejects a bad row before saving anything", async () => {
    await expect(bulkCreateEntries([lesson(), lesson({ day: 9 })])).rejects.toMatchObject({
      statusCode: 400,
      message: "Row 2: Pick a school day (Monday to Friday)",
    });
    expect(TimetableEntry.create).not.toHaveBeenCalled();
  });
  it("needs at least one row", async () => {
    await expect(bulkCreateEntries([])).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("copyTimetable", () => {
  it("copies classes not built yet, skips archived teachers/subjects", async () => {
    store.entries.push(
      { ...lesson({ termId: 3 }), timetableEntryId: 90 },
      { ...lesson({ termId: 3, subjectId: 102 }), timetableEntryId: 91 }, // archived subject
      { ...lesson({ termId: 3, teacherId: 12, day: 2 }), timetableEntryId: 92 }, // archived teacher
      { ...lesson({ termId: 3, classId: 2 }), timetableEntryId: 93 },
      { ...lesson({ termId: 2, classId: 2, day: 3 }), timetableEntryId: 94 } // JHS 2 already started in term 2
    );
    nextId = 100;
    const out = await copyTimetable({ fromTermId: 3, toTermId: 2 });
    expect(out).toEqual({ copied: 1, skipped: 2, classes: 1, classesAlreadyBuilt: 1 });
    expect(store.entries.filter((e) => e.termId === 2 && e.classId === 1)).toHaveLength(1);
  });
  it("skips lessons of archived classes (review fix)", async () => {
    CLASSES.push({ classId: 7, name: "Old class", teacherId: null, isDeleted: true });
    try {
      store.entries.push({ ...lesson({ termId: 3, classId: 7 }), timetableEntryId: 95 });
      const out = await copyTimetable({ fromTermId: 3, toTermId: 2 });
      expect(out).toMatchObject({ copied: 0, skipped: 1 });
    } finally {
      CLASSES.pop();
    }
  });

  it("refuses the same term twice", async () => {
    await expect(copyTimetable({ fromTermId: 2, toTermId: 2 })).rejects.toMatchObject({ statusCode: 400 });
  });
});

it("syncAssignmentsFromTimetable writes the plan", async () => {
  store.entries.push({ ...lesson(), timetableEntryId: 1 }, { ...lesson({ subjectId: 101, teacherId: 10, day: 2 }), timetableEntryId: 2 });
  const out = await syncAssignmentsFromTimetable({ termId: 2 }, { createdBy: "admin" });
  expect(out).toEqual({ set: 1, unchanged: 1, conflicts: [] });
  expect(store.assignments).toEqual([
    expect.objectContaining({ classId: 1, subjectId: 100, termId: 2, teacherId: 11, createdBy: "admin" }),
  ]);
});

it("replacePeriods swaps the whole schedule in a transaction", async () => {
  store.periods = [{ label: "Old" }];
  const out = await replacePeriods([{ label: "Period 1", startTime: "08:00", endTime: "08:40" }]);
  expect(out).toEqual([{ label: "Period 1", startTime: "08:00", endTime: "08:40", isBreak: false, sortOrder: 1 }]);
  await expect(replacePeriods([{ label: "", startTime: "08:00", endTime: "08:40" }])).rejects.toMatchObject({ statusCode: 400 });
  expect(store.periods).toHaveLength(1); // the failed save changed nothing
});

describe("getPortalTimetable", () => {
  beforeEach(() => {
    store.entries.push(
      { ...lesson(), timetableEntryId: 1 },
      { ...lesson({ classId: 2, teacherId: 10, day: 2 }), timetableEntryId: 2 },
      { ...lesson({ termId: 3 }), timetableEntryId: 3 }
    );
  });
  it("gives a pupil their class's lessons for the open term", async () => {
    Student.findOne.mockResolvedValue({ studentId: 5, classId: 1, class: "JHS 1" });
    const out = await getPortalTimetable({ id: "5", userRole: "STU" });
    expect(out).toMatchObject({ view: "class", title: "JHS 1", term: { termId: 2 } });
    expect(out.entries.map((e) => e.timetableEntryId)).toEqual([1]);
    expect(out.days).toHaveLength(5);
  });
  it("finds a legacy pupil's class by name", async () => {
    Student.findOne.mockResolvedValue({ studentId: 5, classId: null, class: "JHS 2" });
    const out = await getPortalTimetable({ id: "5", userRole: "STU" });
    expect(out.entries.map((e) => e.timetableEntryId)).toEqual([2]);
  });
  it("gives a teacher their own lessons", async () => {
    const out = await getPortalTimetable({ id: "11", userRole: "STAFF" });
    expect(out).toMatchObject({ view: "teacher", title: "Kofi Mensah" });
    expect(out.entries.map((e) => e.timetableEntryId)).toEqual([1]);
  });
  it("returns no lessons between terms", async () => {
    Term.findOne.mockResolvedValue(null);
    const out = await getPortalTimetable({ id: "11", userRole: "STAFF" });
    expect(out).toMatchObject({ term: null, entries: [] });
  });
  it("403 for an archived teacher", async () => {
    await expect(getPortalTimetable({ id: "12", userRole: "STAFF" })).rejects.toMatchObject({ statusCode: 403 });
  });
});
