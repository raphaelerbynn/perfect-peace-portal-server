// Students page on the live data: pupils repeated once per fee row, gender
// counts that didn't add up, Class Teachers with an empty list, and the
// graduated / left tick boxes (Students page + dashboard).
import { Op } from "sequelize";

jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: {
    fn: (name, ...args) => ({ fn: name, args }),
    col: (c) => ({ col: c }),
    where: (a, b) => ({ where: [a, b] }),
    literal: (x) => ({ literal: x }),
  },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findOne: jest.fn(), findAll: jest.fn(), count: jest.fn() },
  ClassFee: {},
  Parent: {},
  StudentFee: {},
  Student: { findAll: jest.fn(), count: jest.fn() },
  Teacher: { findOne: jest.fn(), count: jest.fn() },
}));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn() }));

import { Class, Student, Teacher } from "../models/index.js";
import { getStudents } from "../services/test.js";
import { getDashboardSummary, getStudentsOwing } from "../services/dashboard.js";

// All values in a where clause, including under Sequelize's Symbol keys.
const ids = (w) => {
  if (w == null || typeof w !== "object") return [w];
  const keys = [...Object.keys(w), ...Object.getOwnPropertySymbols(w)];
  return keys.flatMap((k) => ids(w[k]));
};
const inst = (o) => ({ ...o, get: () => ({ ...o }) });
beforeEach(() => {
  jest.resetAllMocks();
  Student.count.mockResolvedValue(3);
  Student.findAll.mockImplementation(async (opts) => {
    if (opts.group) return [{ g: "male", n: "2" }, { g: "female", n: "1" }]; // "MALE" folded to male in SQL
    if (opts.attributes?.length === 1 && opts.attributes[0] === "studentId") return [{ studentId: 1 }, { studentId: 2 }];
    return [inst({ studentId: 1, gender: "MALE", parent: { fName: "Ama" }, class_: { classFee: [{ amount: 1 }, { amount: 2 }] } }), inst({ studentId: 2, gender: "female" })];
  });
});

describe("getStudents (paged)", () => {
  it("each pupil once, nested rows, gender counted over the whole list", async () => {
    const out = await getStudents({ page: 1, limit: 50 });
    expect(out.students.map((s) => s.studentId)).toEqual([1, 2]);
    expect(out.students[0].parent.fName).toBe("Ama");
    expect(out.genderCounts).toEqual({ male: 2, female: 1, other: 0 });
    // the page of ids is taken WITHOUT joins and in a fixed order
    const idCall = Student.findAll.mock.calls.find(([o]) => o.attributes?.[0] === "studentId")[0];
    expect(idCall.include).toBeUndefined();
    expect(idCall.order.at(-1)).toEqual(["studentId", "ASC"]);
    // details are not raw (raw rows repeated a pupil per fee item)
    const detail = Student.findAll.mock.calls.find(([o]) => o.include)[0];
    expect(detail.raw).toBeUndefined();
  });

  it("gender filter ignores case (live has 'MALE' and 'male')", async () => {
    await getStudents({ page: 1, limit: 50, gender: "Male" });
    expect(Student.count.mock.calls[0][0].where.gender).toEqual({ [Op.iLike]: "Male" });
  });

  it("hides the unticked graduated / left classes, but a picked class always shows", async () => {
    await getStudents({ page: 1, limit: 50, excludeClassIds: "39,40" });
    const where = Student.count.mock.calls[0][0].where;
    expect(ids(where[Op.and])).toContain(39);
    Student.count.mockClear();
    await getStudents({ page: 1, limit: 50, excludeClassIds: "39,40", classId: 39 });
    expect(Student.count.mock.calls[0][0].where[Op.and]).toBeUndefined();
  });

  it("a Class Teacher is scoped by the class record's teacher (live), not only Teacher.class_id", async () => {
    Class.findOne.mockResolvedValue({ classId: 3 });
    await getStudents({ page: 1, limit: 50, requester: { ownClassOnly: true, teacherId: 54 } });
    expect(Class.findOne.mock.calls[0][0].where.teacherId).toBe(54);
    expect(Student.count.mock.calls[0][0].where.classId).toBe(3);
    expect(Teacher.findOne).not.toHaveBeenCalled();
  });
});

describe("dashboard tick boxes", () => {
  beforeEach(() => {
    Class.findAll.mockResolvedValue([{ classId: 39, name: "Guaduants" }, { classId: 40, name: "Students Left" }]);
    Class.count.mockResolvedValue(15);
    Teacher.count.mockResolvedValue(17);
    Student.count.mockResolvedValue(1);
  });
  it("unticked: graduated / left pupils are not counted; ticked: they are", async () => {
    const off = await getDashboardSummary({ include: "none" });
    expect(off.alumniClasses.map((c) => c.included)).toEqual([false, false]);
    const studentsWhere = Student.count.mock.calls[2][0].where;
    expect(ids(studentsWhere[Op.or])).toContain(39);
    Student.count.mockClear();
    const on = await getDashboardSummary({ include: "39" });
    expect(on.alumniClasses.map((c) => c.included)).toEqual([true, false]);
    const w = Student.count.mock.calls[2][0].where;
    expect(ids(w[Op.or])).not.toContain(39);
    expect(ids(w[Op.or])).toContain(40);
  });
  it("chart: every class with its pupil count, alumni flagged (not limited to a teacher's class)", async () => {
    Class.findAll
      .mockResolvedValueOnce([{ classId: 39, name: "Guaduants" }]) // the alumni classes
      .mockResolvedValueOnce([{ classId: 5, name: "CLASS 6" }, { classId: 7, name: "K.G 1" }, { classId: 39, name: "Guaduants" }]);
    Student.count.mockImplementation(async (opts) =>
      opts?.group ? [{ classId: 5, count: "31" }, { classId: 39, count: 4 }] : 1
    );
    const s = await getDashboardSummary({ include: "none" });
    expect(s.classCounts).toEqual([
      { classId: 5, name: "CLASS 6", totalStudents: 31, isAlumni: false },
      { classId: 7, name: "K.G 1", totalStudents: 0, isAlumni: false },
      { classId: 39, name: "Guaduants", totalStudents: 4, isAlumni: true },
    ]);
    const grouped = Student.count.mock.calls.find(([o]) => o?.group)[0];
    expect(grouped.where.classId).toBeUndefined(); // no class filter
  });
  it("owing list: everyone without the parameter (other screens), filtered with it", async () => {
    Student.findAll.mockResolvedValue([]);
    await getStudentsOwing();
    expect(Student.findAll.mock.calls[0][0].where[Op.or]).toBeUndefined();
    Student.findAll.mockClear();
    await getStudentsOwing({ include: "none" });
    expect(Student.findAll.mock.calls[0][0].where[Op.or]).toBeDefined();
  });
});
