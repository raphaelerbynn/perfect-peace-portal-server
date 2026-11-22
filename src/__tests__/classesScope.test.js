// A Class Teacher office login's class pickers (GET /class) show only the class
// they are class teacher of; GET /class?scope=all (the read-only Classes page)
// and Administrators / Accountants / portal get every class.
import { Op } from "sequelize";

jest.mock("../config/database.js", () => ({ __esModule: true, default: {} }));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn() }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findAll: jest.fn() },
  ClassFee: { findAll: jest.fn() },
  Student: { count: jest.fn() },
  Teacher: { findOne: jest.fn(), findAll: jest.fn() },
}));

import { Class, ClassFee, Student, Teacher } from "../models/index.js";
import { classes } from "../services/classes.js";
import { fetchClass } from "../controllers/onlyTeacherController.js";

const row = (classId, name) => ({ classId, name, dataValues: {} });
const ALL = [row(3, "CLASS 6"), row(5, "K.G 1"), row(7, "CLASS 5")];
let lastWhere;
beforeEach(() => {
  jest.resetAllMocks();
  lastWhere = undefined;
  ClassFee.findAll.mockResolvedValue([]);
  Student.count.mockResolvedValue([]);
  Teacher.findOne.mockResolvedValue({ classId: null });
  Teacher.findAll.mockResolvedValue([]);
  Class.findAll.mockImplementation(async ({ where, attributes }) => {
    if (attributes) return where.teacherId === 54 ? [{ classId: 3 }] : []; // class-teacher lookup
    lastWhere = where;
    const ids = where.classId?.[Op.in];
    return ids ? ALL.filter((c) => ids.includes(c.classId)) : ALL;
  });
});

it("Administrator and portal callers get every class", async () => {
  expect((await classes({ category: "Administrator" })).map((c) => c.classId)).toEqual([3, 5, 7]);
  expect((await classes()).map((c) => c.classId)).toEqual([3, 5, 7]);
});

it("a Class Teacher gets only the class they are class teacher of", async () => {
  expect((await classes({ category: "Class Teacher", teacherId: 54 })).map((c) => c.classId)).toEqual([3]);
});

it("a Class Teacher with nothing assigned sees no classes (not all of them)", async () => {
  expect(await classes({ category: "Class Teacher", teacherId: 99 })).toEqual([]);
  expect(lastWhere).toBeUndefined();
});

it("a class with no teacher on its record shows the one teacher whose staff record names it (live: KG 2)", async () => {
  Teacher.findAll.mockResolvedValue([{ teacherId: 11, classId: 5 }]);
  const out = await classes({ category: "Administrator" });
  expect(out.find((c) => c.classId === 5).dataValues.teacherId).toBe(11);
  expect(out.find((c) => c.classId === 7).dataValues.teacherId).toBeUndefined();
});

it("each class carries its teacher's name (the Classes page has no staff list for a Class Teacher)", async () => {
  ALL[0].teacherId = 54;
  Teacher.findAll.mockImplementation(async ({ attributes }) =>
    attributes.includes("fName") ? [{ teacherId: 54, fName: "Desmond", lName: "Assabil" }] : []
  );
  const out = await classes({ category: "Administrator" });
  delete ALL[0].teacherId;
  expect(out.find((c) => c.classId === 3).dataValues.teacherName).toBe("Desmond Assabil");
  expect(out.find((c) => c.classId === 5).dataValues.teacherName).toBeNull();
});

it("GET /class?scope=all lists every class for a Class Teacher; plain /class stays their own", async () => {
  const call = async (query) => {
    const res = { json: jest.fn() };
    await fetchClass({ user: { category: "Class Teacher", teacherId: 54 }, query }, res, jest.fn());
    return res.json.mock.calls[0][0].map((c) => c.classId);
  };
  expect(await call({})).toEqual([3]);
  expect(await call({ scope: "all" })).toEqual([3, 5, 7]);
});
