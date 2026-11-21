// A Class Teacher office login sees only the classes assigned to them on the
// Classes page (and every class picker): class teacher of, or teaching a
// subject there this term. Administrators / Accountants / portal: every class.
import { Op } from "sequelize";

jest.mock("../config/database.js", () => ({ __esModule: true, default: {} }));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn() }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findAll: jest.fn() },
  ClassFee: { findAll: jest.fn() },
  Student: { count: jest.fn() },
  Teacher: { findOne: jest.fn(), findAll: jest.fn() },
  Term: { findOne: jest.fn() },
  TeachingAssignment: { findAll: jest.fn() },
}));

import { Class, ClassFee, Student, TeachingAssignment, Teacher, Term } from "../models/index.js";
import { classes } from "../services/classes.js";
import { officeUser } from "../testSupport/officeUser.js";

const row = (classId, name) => ({ classId, name, dataValues: {} });
const ALL = [row(3, "CLASS 6"), row(5, "K.G 1"), row(7, "CLASS 5")];
let lastWhere;
beforeEach(() => {
  jest.resetAllMocks();
  lastWhere = undefined;
  ClassFee.findAll.mockResolvedValue([]);
  Student.count.mockResolvedValue([]);
  Term.findOne.mockResolvedValue({ termId: 15 });
  Teacher.findOne.mockResolvedValue({ classId: null });
  TeachingAssignment.findAll.mockResolvedValue([]);
  Teacher.findAll.mockResolvedValue([]);
  Class.findAll.mockImplementation(async ({ where, attributes }) => {
    if (attributes) return where.teacherId === 54 ? [{ classId: 3 }] : []; // class-teacher lookup
    lastWhere = where;
    const ids = where.classId?.[Op.in];
    return ids ? ALL.filter((c) => ids.includes(c.classId)) : ALL;
  });
});

it("Administrator and portal callers get every class", async () => {
  expect((await classes(officeUser("Administrator"))).map((c) => c.classId)).toEqual([3, 5, 7]);
  expect((await classes()).map((c) => c.classId)).toEqual([3, 5, 7]);
});

it("a Class Teacher gets only the class they are class teacher of", async () => {
  expect((await classes(officeUser("Class Teacher", { teacherId: 54 }))).map((c) => c.classId)).toEqual([3]);
});

it("…plus classes where they teach a subject in the open term", async () => {
  TeachingAssignment.findAll.mockResolvedValue([{ classId: 7 }, { classId: 7 }]);
  expect((await classes(officeUser("Class Teacher", { teacherId: 54 }))).map((c) => c.classId)).toEqual([3, 7]);
  expect(TeachingAssignment.findAll.mock.calls[0][0].where).toEqual({ teacherId: 54, termId: 15 });
});

it("a Class Teacher with nothing assigned sees no classes (not all of them)", async () => {
  expect(await classes(officeUser("Class Teacher", { teacherId: 99 }))).toEqual([]);
  expect(lastWhere).toBeUndefined();
});

it("a class with no teacher on its record shows the one teacher whose staff record names it (live: KG 2)", async () => {
  Teacher.findAll.mockResolvedValue([{ teacherId: 11, classId: 5 }]);
  const out = await classes(officeUser("Administrator"));
  expect(out.find((c) => c.classId === 5).dataValues.teacherId).toBe(11);
  expect(out.find((c) => c.classId === 7).dataValues.teacherId).toBeUndefined();
});
