// Security review: a Class Teacher office login may only write for pupils in
// its own class, in the open term. Administrators are unchanged.
jest.mock("../config/database.js", () => ({ __esModule: true, default: {} }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Attendance: {},
  TotalAttendance: {},
  Class: { findOne: jest.fn() },
  Student: { findAll: jest.fn() },
  Teacher: { findOne: jest.fn() },
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn() }));

import { Class, Student, Teacher } from "../models/index.js";
import { getTerm } from "../services/term.js";
import { assertClassWrite } from "../services/attendance.js";

const ct = { category: "Class Teacher", teacherId: 3 };
beforeEach(() => {
  jest.resetAllMocks();
  getTerm.mockResolvedValue({ termId: 5 });
  Class.findOne.mockImplementation(async ({ where }) => (where.teacherId === 3 || where.name === "JHS 1" ? { classId: 1, name: "JHS 1" } : null));
  Teacher.findOne.mockResolvedValue({ teacherId: 3, classId: 1 });
  Student.findAll.mockImplementation(async ({ where }) => {
    const ids = Object.getOwnPropertySymbols(where.studentId).flatMap((s) => where.studentId[s]);
    return ids.filter((id) => [10, 11].includes(id)).map((studentId) => ({ studentId })); // 10, 11 are in JHS 1
  });
});

it("own pupils, open term: allowed", async () => {
  await expect(assertClassWrite(ct, "JHS 1", [10, 11], 5)).resolves.toBeUndefined();
});
it("a pupil from another class: 403", async () => {
  await expect(assertClassWrite(ct, "JHS 1", [10, 99])).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("not in your class") });
});
it("a closed term: 403", async () => {
  await expect(assertClassWrite(ct, "JHS 1", [10], 4)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining("open term") });
});
it("Administrator: unchanged (no pupil or term check)", async () => {
  await expect(assertClassWrite({ category: "Administrator" }, "JHS 1", [99], 4)).resolves.toBeUndefined();
  expect(Student.findAll).not.toHaveBeenCalled();
});

it('a class name stored with a stray space (" NURSERY 2", live data) still finds its pupils', async () => {
  Class.findOne.mockImplementation(async ({ where }) => (where.teacherId === 3 ? { classId: 16, name: " NURSERY 2" } : null));
  Student.findAll.mockImplementation(async ({ where }) => {
    const byClass = where[Object.getOwnPropertySymbols(where)[0]]?.[0]?.classId;
    return byClass === 16 ? [{ studentId: 10 }] : [];
  });
  await expect(assertClassWrite(ct, "NURSERY 2", [10], 5)).resolves.toBeUndefined();
  await expect(assertClassWrite(ct, " NURSERY 2", [10], 5)).resolves.toBeUndefined();
});
