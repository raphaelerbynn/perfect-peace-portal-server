// B2: /teacher/* is for portal STAFF tokens only; /teaching-assignments is
// Administrator-only. Services stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/teacherTools.js", () => ({
  __esModule: true,
  getMyClasses: jest.fn(async (id) => ({ handler: "getMyClasses", teacherId: id })),
  getRegister: jest.fn(async () => ({ handler: "getRegister" })),
  saveRegister: jest.fn(async () => ({ studentAttendance: [], register: { handler: "saveRegister" } })),
  getScores: jest.fn(async () => ({ handler: "getScores" })),
  saveScores: jest.fn(async () => ({ handler: "saveScores" })),
  getKgRatings: jest.fn(async () => ({ handler: "getKgRatings" })),
  saveKgRatings: jest.fn(async () => ({ handler: "saveKgRatings" })),
}));
jest.mock("../services/teachingAssignment.js", () => ({
  __esModule: true,
  listTeachingAssignments: jest.fn(async () => []),
  setTeachingAssignment: jest.fn(async (body, opts) => ({ ...body, ...opts })),
  removeTeachingAssignment: jest.fn(async () => ({ deleted: 1 })),
  copyTeachingAssignments: jest.fn(async () => ({ copied: 0, skipped: 0 })),
}));

const app = require("../index.js").default;
const { getKgRatings, saveKgRatings, saveRegister } = require("../services/teacherTools.js");
const { setTeachingAssignment } = require("../services/teachingAssignment.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const teacher = sign({ id: "3", userRole: "STAFF" });
const student = sign({ id: 7, userRole: "STU" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

describe("/teacher/*", () => {
  it("a STAFF token reaches the teacher tools, with its id as the teacher", async () => {
    const res = await auth(request(app).get("/teacher/my-classes"), teacher);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler: "getMyClasses", teacherId: 3 });
  });

  it("saving the register returns the refreshed register", async () => {
    const res = await auth(request(app).post("/teacher/register"), teacher).send({ classId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler: "saveRegister" });
    expect(saveRegister).toHaveBeenCalledWith(3, { classId: 1 });
  });

  it.each([
    ["a student token", student],
    ["an office token", admin],
    ["a Class Teacher office token", classTeacher],
  ])("refuses %s (403)", async (_l, token) => {
    const res = await auth(request(app).get("/teacher/scores"), token);
    expect(res.status).toBe(403);
  });

  it("no token = 401", async () => {
    expect((await request(app).get("/teacher/my-classes")).status).toBe(401);
  });

  it("KG ratings: a STAFF token reads and saves with its own id", async () => {
    const got = await auth(request(app).get("/teacher/kg-ratings?classId=3&studentId=1"), teacher);
    expect(got.status).toBe(200);
    expect(getKgRatings).toHaveBeenCalledWith(3, { classId: "3", studentId: "1" });
    const body = { classId: 3, studentId: 1, ratings: { "Physical Development": { "Shows balance while moving": "improved" } } };
    const saved = await auth(request(app).post("/teacher/kg-ratings"), teacher).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ handler: "saveKgRatings" });
    expect(saveKgRatings).toHaveBeenCalledWith(3, body);
  });

  it.each([
    ["a student token", student],
    ["an office token", admin],
    ["a Class Teacher office token", classTeacher],
  ])("KG ratings refuse %s (403)", async (_l, token) => {
    getKgRatings.mockClear();
    saveKgRatings.mockClear();
    expect((await auth(request(app).get("/teacher/kg-ratings?classId=3"), token)).status).toBe(403);
    expect((await auth(request(app).post("/teacher/kg-ratings"), token).send({ classId: 3 })).status).toBe(403);
    expect(getKgRatings).not.toHaveBeenCalled();
    expect(saveKgRatings).not.toHaveBeenCalled();
  });
});

describe("/teaching-assignments", () => {
  it("Administrator can set one; the server records who", async () => {
    const res = await auth(request(app).post("/teaching-assignments"), admin).send({ teacherId: 3, classId: 1, subjectId: 2, termId: 5 });
    expect(res.status).toBe(200);
    expect(setTeachingAssignment).toHaveBeenCalledWith(
      { teacherId: 3, classId: 1, subjectId: 2, termId: 5 },
      { createdBy: "admin" }
    );
  });

  it.each([
    ["Accountant", accountant],
    ["Class Teacher", classTeacher],
    ["portal teacher", teacher],
  ])("refuses %s (403)", async (_l, token) => {
    const res = await auth(request(app).get("/teaching-assignments"), token);
    expect(res.status).toBe(403);
  });
});
