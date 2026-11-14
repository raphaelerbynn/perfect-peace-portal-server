// B9: staff attendance service (SchoolPro spec cases + PP rules). Models
// mocked; the transaction mock passes a fake transaction to the callback.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn() } }));
jest.mock("../models/index.js", () => {
  const model = () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn() });
  return { __esModule: true, AcademicYear: model(), StaffAttendance: model(), Teacher: model(), Term: model() };
});
jest.mock("../services/term.js", () => ({ __esModule: true, requireActiveTerm: jest.fn() }));
jest.mock("../services/academicYear.js", () => ({ __esModule: true, termName: (t) => `Term ${t.term}` }));

import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AcademicYear, StaffAttendance, Teacher, Term } from "../models/index.js";
import { requireActiveTerm } from "../services/term.js";
import {
  dateInTerm,
  getOneStaffSummary,
  getStaffDay,
  getStaffSummary,
  normaliseSave,
  resolveRange,
  saveStaffDay,
  summarise,
} from "../services/staffAttendance.js";

const TERM = { termId: 9, term: "1", active: true, startDate: "2026-09-08", endDate: "2026-12-18" };
const TODAY = "2026-11-14";
const admin = { category: "Administrator", username: "head" };
const tx = { LOCK: { UPDATE: "UPDATE" } };

beforeEach(() => {
  jest.resetAllMocks();
  sequelize.transaction.mockImplementation((fn) => fn(tx));
  requireActiveTerm.mockResolvedValue(TERM);
  StaffAttendance.findAll.mockResolvedValue([]);
  StaffAttendance.destroy.mockResolvedValue(0);
});

describe("summarise: % = (present + late) / marked", () => {
  it("counts each status and leaves unmarked days out", () => {
    const s = summarise([
      { status: "PRESENT" }, { status: "LATE" }, { status: "ABSENT" },
      { status: "SICK" }, { status: "ON_LEAVE" }, { status: "PERMISSION" },
    ]);
    expect(s.marked).toBe(6);
    expect(s.attended).toBe(2);
    expect(s.percent).toBe(33.33);
    expect(s.counts).toEqual({ PRESENT: 1, ABSENT: 1, LATE: 1, SICK: 1, ON_LEAVE: 1, PERMISSION: 1 });
  });
  it("SchoolPro: present + absent = 50%; present + on leave = 50%", () => {
    expect(summarise([{ status: "PRESENT" }, { status: "ABSENT" }]).percent).toBe(50);
    expect(summarise([{ status: "PRESENT" }, { status: "ON_LEAVE" }]).percent).toBe(50);
  });
  it("nothing marked = no % (not 0%, not 100%)", () => {
    expect(summarise([])).toMatchObject({ marked: 0, percent: null });
  });
  it("trims padded statuses", () => {
    expect(summarise([{ status: "LATE   " }]).percent).toBe(100);
  });
});

describe("normaliseSave", () => {
  it("cleans entries (status case, empty time, remarks) and drops removals that are also entries", () => {
    const out = normaliseSave({
      date: "2026-11-13",
      entries: [{ teacherId: "3", status: "late", timeIn: "07:50", remarks: "  traffic " }, { teacherId: 4, status: "PRESENT", timeIn: "" }],
      removals: [4, 5, 5],
    });
    expect(out.entries).toEqual([
      { teacherId: 3, status: "LATE", timeIn: "07:50", remarks: "traffic" },
      { teacherId: 4, status: "PRESENT", timeIn: null, remarks: null },
    ]);
    expect(out.removals).toEqual([5]);
  });
  it.each([
    [{ date: "2026-11-13" }, /at least one/],
    [{ date: "2026-02-30", entries: [{ teacherId: 1, status: "PRESENT" }] }, /valid date/],
    [{ date: "2026-11-13", entries: [{ teacherId: 1, status: "HERE" }] }, /Status must be/],
    [{ date: "2026-11-13", entries: [{ teacherId: 1, status: "PRESENT", timeIn: "25:00" }] }, /Time in/],
    [{ date: "2026-11-13", entries: [{ teacherId: 0, status: "PRESENT" }] }, /invalid staff id/],
    [{ date: "2026-11-13", entries: [{ teacherId: 1, status: "PRESENT" }, { teacherId: 1, status: "ABSENT" }] }, /twice/],
    [{ date: "2026-11-13", entries: [{ teacherId: 1, status: "PRESENT", remarks: "x".repeat(301) }] }, /300/],
    [{ date: "2026-11-13", entries: "nope" }, /lists/],
  ])("refuses %j", (body, msg) => {
    expect(() => normaliseSave(body)).toThrow(msg);
  });
});

describe("dateInTerm (inclusive)", () => {
  it.each([["2026-09-08", true], ["2026-12-18", true], ["2026-09-07", false], ["2026-12-19", false]])("%s -> %s", (d, ok) => {
    expect(dateInTerm(d, TERM)).toBe(ok);
  });
});

describe("saveStaffDay", () => {
  const body = { date: "2026-11-13", entries: [{ teacherId: 3, status: "PRESENT" }, { teacherId: 4, status: "LATE", timeIn: "08:10" }], removals: [5] };

  it("upserts on (teacher, date): updates the saved mark, creates the new one, removes, all in one transaction", async () => {
    Teacher.findAll.mockResolvedValue([{ teacherId: 3 }, { teacherId: 4 }]);
    StaffAttendance.findAll.mockResolvedValue([{ staffAttendanceId: 70, teacherId: 3, date: "2026-11-13", status: "ABSENT" }]);
    StaffAttendance.destroy.mockResolvedValue(1);

    const out = await saveStaffDay(body, admin, { today: TODAY });

    expect(out).toEqual({ date: "2026-11-13", termId: 9, saved: 2, removed: 1 });
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(requireActiveTerm).toHaveBeenCalledWith({ transaction: tx });
    expect(StaffAttendance.findAll).toHaveBeenCalledWith(expect.objectContaining({ transaction: tx, lock: "UPDATE" }));
    expect(StaffAttendance.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PRESENT", termId: 9, markedBy: "head" }),
      { where: { staffAttendanceId: 70 }, transaction: tx }
    );
    expect(StaffAttendance.create).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: 4, date: "2026-11-13", status: "LATE", timeIn: "08:10", termId: 9, markedBy: "head" }),
      { transaction: tx }
    );
    expect(StaffAttendance.destroy).toHaveBeenCalledWith({ where: { date: "2026-11-13", teacherId: { [Op.in]: [5] } }, transaction: tx });
  });

  it("removals only: deletes the marks, writes nothing", async () => {
    StaffAttendance.destroy.mockResolvedValue(2);
    const out = await saveStaffDay({ date: "2026-11-13", removals: [5, 6] }, admin, { today: TODAY });
    expect(out).toMatchObject({ saved: 0, removed: 2 });
    expect(StaffAttendance.create).not.toHaveBeenCalled();
    expect(StaffAttendance.update).not.toHaveBeenCalled();
  });

  it.each([["2026-09-07"], ["2026-12-19"]])("refuses %s (outside the active term) and writes nothing", async (date) => {
    Teacher.findAll.mockResolvedValue([{ teacherId: 3 }]);
    await expect(saveStaffDay({ date, entries: [{ teacherId: 3, status: "PRESENT" }] }, admin, { today: "2026-12-31" })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/inside the open term/),
    });
    expect(StaffAttendance.create).not.toHaveBeenCalled();
    expect(StaffAttendance.destroy).not.toHaveBeenCalled();
  });

  it("no open term: 409", async () => {
    const { AppError } = jest.requireActual("../utils/errorHandling.js");
    requireActiveTerm.mockRejectedValue(new AppError("No term is open. Open a term in Settings first.", 409));
    await expect(saveStaffDay(body, admin, { today: TODAY })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a future date", async () => {
    await expect(saveStaffDay({ ...body, date: "2026-11-15" }, admin, { today: TODAY })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/future/) });
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  it("refuses archived or unknown staff", async () => {
    Teacher.findAll.mockResolvedValue([{ teacherId: 3 }]);
    await expect(saveStaffDay(body, admin, { today: TODAY })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Not active staff.*4/) });
    expect(Teacher.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { teacherId: { [Op.in]: [3, 4] }, isDeleted: { [Op.not]: true } } }));
    expect(StaffAttendance.create).not.toHaveBeenCalled();
  });

  it("a clash on the unique index becomes a 409", async () => {
    Teacher.findAll.mockResolvedValue([{ teacherId: 3 }, { teacherId: 4 }]);
    StaffAttendance.create.mockRejectedValue(Object.assign(new Error("dup"), { name: "SequelizeUniqueConstraintError" }));
    await expect(saveStaffDay(body, admin, { today: TODAY })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("getStaffDay", () => {
  it("lists active staff with their mark or null (unmarked), and archived staff only when they have a mark", async () => {
    Term.findOne.mockResolvedValue(TERM);
    StaffAttendance.findAll.mockResolvedValue([
      { staffAttendanceId: 1, teacherId: 3, termId: 9, date: "2026-11-13", status: "LATE      ", timeIn: "08:05" },
      { staffAttendanceId: 2, teacherId: 8, termId: 9, date: "2026-11-13", status: "PRESENT" },
    ]);
    Teacher.findAll
      .mockResolvedValueOnce([
        { teacherId: 3, fName: "Ama", lName: "Owusu", category: "teaching", isDeleted: false },
        { teacherId: 4, fName: "Kofi", lName: "Mensah", category: "non-teaching", isDeleted: false },
      ])
      .mockResolvedValueOnce([{ teacherId: 8, fName: "Yaw", lName: "Boateng", isDeleted: true }]);

    const day = await getStaffDay("2026-11-13", { today: TODAY });
    expect(day.editable).toBe(true);
    expect(day.staff.map((s) => [s.name, s.record?.status ?? null, s.archived])).toEqual([
      ["Ama Owusu", "LATE", false],
      ["Kofi Mensah", null, false],
      ["Yaw Boateng", "PRESENT", true],
    ]);
    // No password or other private fields asked for.
    expect(Teacher.findAll.mock.calls[0][0].attributes).not.toContain("password");
  });

  it("a day outside the term or in the future can be viewed but not saved", async () => {
    Term.findOne.mockResolvedValue(TERM);
    Teacher.findAll.mockResolvedValue([]);
    expect((await getStaffDay("2026-12-19", { today: "2026-12-31" })).reason).toMatch(/outside the open term/);
    expect((await getStaffDay("2026-11-20", { today: TODAY })).reason).toMatch(/future/);
    Term.findOne.mockResolvedValue(null);
    expect((await getStaffDay("2026-11-13", { today: TODAY })).editable).toBe(false);
  });
});

describe("summaries", () => {
  it("range: termId > academicYearId > from/to > the open term", async () => {
    Term.findOne.mockResolvedValue(TERM);
    expect(await resolveRange({ termId: "9" })).toMatchObject({ kind: "term", where: { termId: 9 } });
    AcademicYear.findOne.mockResolvedValue({ academicYearId: 2, name: "2026/2027", startDate: "2026-08-01", endDate: "2027-07-31" });
    expect(await resolveRange({ academicYearId: "2" })).toMatchObject({
      kind: "year",
      where: { date: { [Op.between]: ["2026-08-01", "2027-07-31"] } },
    });
    expect(await resolveRange({ from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ kind: "range", from: "2026-10-01" });
    expect(await resolveRange({})).toMatchObject({ kind: "term", termId: 9 });
    await expect(resolveRange({ from: "2026-10-31", to: "2026-10-01" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(resolveRange({ from: "2026-10-31" })).rejects.toMatchObject({ statusCode: 400 });
    Term.findOne.mockResolvedValue(null);
    await expect(resolveRange({ termId: "99" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("per staff: everyone listed, % per person, school totals; unmarked staff have no %", async () => {
    StaffAttendance.findAll.mockResolvedValue([
      { teacherId: 3, status: "PRESENT" },
      { teacherId: 3, status: "ABSENT" },
      { teacherId: 4, status: "LATE" },
    ]);
    Teacher.findAll.mockResolvedValue([
      { teacherId: 3, fName: "Ama", lName: "Owusu", isDeleted: false },
      { teacherId: 4, fName: "Kofi", lName: "Mensah", isDeleted: false },
      { teacherId: 5, fName: "Esi", lName: "Asante", isDeleted: false },
    ]);
    const out = await getStaffSummary({ from: "2026-10-01", to: "2026-10-31" });
    expect(out.range).not.toHaveProperty("where");
    expect(out.totals).toMatchObject({ staff: 3, marked: 3, attended: 2, percent: 66.67 });
    expect(out.staff.map((s) => [s.name, s.marked, s.percent])).toEqual([
      ["Ama Owusu", 2, 50],
      ["Esi Asante", 0, null],
      ["Kofi Mensah", 1, 100],
    ]);
  });

  it("one member of staff: summary and records; 404 when unknown", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 3, fName: "Ama", lName: "Owusu", isDeleted: false });
    StaffAttendance.findAll.mockResolvedValue([
      { staffAttendanceId: 2, teacherId: 3, termId: 9, date: "2026-11-13", status: "PRESENT" },
      { staffAttendanceId: 1, teacherId: 3, termId: 9, date: "2026-11-12", status: "SICK", remarks: "clinic" },
    ]);
    Term.findOne.mockResolvedValue(TERM);
    const out = await getOneStaffSummary("3", { termId: 9 });
    expect(out).toMatchObject({ teacher: { name: "Ama Owusu" }, marked: 2, percent: 50 });
    expect(out.records[1]).toMatchObject({ date: "2026-11-12", status: "SICK", remarks: "clinic" });
    expect(StaffAttendance.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { termId: 9, teacherId: 3 } }));

    Teacher.findOne.mockResolvedValue(null);
    await expect(getOneStaffSummary("77", {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(getOneStaffSummary("abc", {})).rejects.toMatchObject({ statusCode: 404 });
  });
});
