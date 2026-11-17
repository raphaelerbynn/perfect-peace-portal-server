// B10: the Head Teacher works on results and attendance for EVERY class (no
// own-class scoping), in the open term; the Class Teacher keeps own-class
// scoping. The class-scoping helpers run for real; the data services are
// stubbed and the models spied on, so no database is touched.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/term.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/term.js"),
  getTerm: jest.fn(async () => ({ termId: 5 })),
}));
jest.mock("../services/results.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/results.js"),
  getClassResult: jest.fn(async () => [{ dataValues: { studentId: 20 } }]),
  getClassMarks: jest.fn(async () => [{ studentId: 20, subjectId: 4 }]),
  upsertMarksResult: jest.fn(async (v) => ({ saved: v.studentId })),
  removeResult: jest.fn(async () => ({ deleted: 1 })),
}));
jest.mock("../services/attendance.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/attendance.js"),
  getAttendance: jest.fn(async () => [{ studentId: 20, status: "Present" }]),
  markClassAttendance: jest.fn(async () => ({ saved: 1 })),
}));
jest.mock("../services/notify.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/notify.js"),
  notifyAbsences: jest.fn(async () => undefined),
}));
jest.mock("../services/test.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/test.js"),
  getParentContact: jest.fn(async () => null),
}));

const app = require("../index.js").default;
const { Class, Student } = require("../models/index.js");
const results = require("../services/results.js");
const attendance = require("../services/attendance.js");
const { assertClassAccess, assertClassWrite, getTeacherClassName } = attendance;

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const headTeacher = sign({ category: "Head Teacher", username: "head", teacherId: 9 });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

const HT = { category: "Head Teacher", username: "head", teacherId: 9 };

beforeEach(() => {
  jest.clearAllMocks();
  // Teacher 3 is the Class Teacher of JHS 1; the Head Teacher (9) has no class.
  jest.spyOn(Class, "findOne").mockImplementation(async ({ where }) =>
    where?.teacherId === 3 ? { classId: 1, name: "JHS 1" } : null
  );
  jest.spyOn(Student, "findAll").mockResolvedValue([]);
});
afterAll(() => jest.restoreAllMocks());

describe("class-scoping helpers", () => {
  it("a Head Teacher is never class-scoped", async () => {
    await expect(getTeacherClassName(HT)).resolves.toBeNull();
    await expect(assertClassAccess(HT, "JHS 2")).resolves.toBeUndefined();
    expect(Class.findOne).not.toHaveBeenCalled();
  });

  it("a Head Teacher writes for pupils of any class in the open term", async () => {
    await expect(assertClassWrite(HT, "JHS 2", [20, 21], 5)).resolves.toBeUndefined();
    expect(Student.findAll).not.toHaveBeenCalled();
  });

  it("a Head Teacher can't change a closed term (that stays with the Administrator)", async () => {
    await expect(assertClassWrite(HT, "JHS 2", [20], 4)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("Head Teachers can only change the open term"),
    });
    await expect(assertClassWrite({ category: "Administrator" }, "JHS 2", [20], 4)).resolves.toBeUndefined();
  });

  it("a Class Teacher is still limited to their own class", async () => {
    await expect(assertClassAccess({ category: "Class Teacher", teacherId: 3 }, "JHS 2")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertClassAccess({ category: "Class Teacher", teacherId: 3 }, "JHS 1")).resolves.toBeUndefined();
  });
});

describe("routes: results and attendance for a class that isn't the Head Teacher's", () => {
  it("reads a class's results", async () => {
    const res = await auth(request(app).get("/student-results?class=JHS%202&term=5"), headTeacher);
    expect(res.status).toBe(200);
    expect(results.getClassResult).toHaveBeenCalled();
  });

  it("writes a subject result and deletes a result", async () => {
    const body = { class: "JHS 2", studentId: 20, subjectId: 4, termId: 5, classScore: 30, examScore: 50 };
    const res = await auth(request(app).post("/upsert-single-subject-result"), headTeacher).send(body);
    expect(res.status).toBe(200);
    expect(results.upsertMarksResult).toHaveBeenCalledWith(expect.objectContaining({ studentId: 20, enteredBy: "head" }));
    const del = await auth(request(app).delete("/delete-result?student_id=20&class=JHS%202&termId=5"), headTeacher);
    expect(del.status).toBe(200);
    expect(results.removeResult).toHaveBeenCalledWith(expect.objectContaining({ class: "JHS 2" }));
  });

  it("a closed term's result is refused", async () => {
    const res = await auth(request(app).post("/upsert-single-subject-result"), headTeacher).send({ class: "JHS 2", studentId: 20, subjectId: 4, termId: 4 });
    expect(res.status).toBe(403);
    expect(results.upsertMarksResult).not.toHaveBeenCalled();
  });

  it("reads and marks attendance", async () => {
    const read = await auth(request(app).get("/student-attendance?class=JHS%202&date=2026-11-17"), headTeacher);
    expect(read.status).toBe(200);
    const mark = await auth(request(app).post("/mark-attendance"), headTeacher).send({
      class: "JHS 2",
      dateMarked: "2026-11-17",
      studentAttendance: [{ studentId: 20, status: "Present" }],
    });
    expect(mark.status).toBe(200);
    expect(attendance.markClassAttendance).toHaveBeenCalledWith(expect.objectContaining({ className: "JHS 2" }));
  });

  it("the same requests from another class's Class Teacher are refused", async () => {
    expect((await auth(request(app).get("/student-results?class=JHS%202&term=5"), classTeacher)).status).toBe(403);
    const mark = await auth(request(app).post("/mark-attendance"), classTeacher).send({
      class: "JHS 2",
      dateMarked: "2026-11-17",
      studentAttendance: [{ studentId: 20, status: "Present" }],
    });
    expect(mark.status).toBe(403);
    expect(attendance.markClassAttendance).not.toHaveBeenCalled();
  });
});

describe("news: the Head Teacher manages posts like the Administrator", () => {
  const posts = jest.requireActual("../services/posts.js");
  const ht = { type: "OFFICE", category: "Head Teacher", username: "head" };
  const ct = { type: "OFFICE", category: "Class Teacher", username: "ct" };
  it("sees drafts, manages anyone's post and moderates comments", () => {
    const draft = { status: "DRAFT", audience: "ALL", createdBy: "admin" };
    expect(posts.isNewsManager(ht)).toBe(true);
    expect(posts.canSee(draft, ht)).toBe(true);
    expect(posts.canManage(draft, ht)).toBe(true);
    expect(posts.canSee(draft, ct)).toBe(false);
    expect(posts.canManage(draft, ct)).toBe(false);
    expect(posts.isNewsManager({ type: "OFFICE", category: "Accountant" })).toBe(false);
    expect(posts.isNewsManager({ type: "STAFF", category: "Head Teacher" })).toBe(false);
  });
});
