// B6: who may read and save the office score sheet. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/scoreSheet.js", () => ({
  __esModule: true,
  getOfficeSheet: jest.fn(async (user, q) => ({ user, q })),
  saveOfficeSheet: jest.fn(async (user, body) => ({ saved: body.scores?.length ?? 0 })),
}));

const app = require("../index.js").default;
const svc = require("../services/scoreSheet.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const teacher = sign({ id: "3", userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

it.each([["Administrator", admin], ["Class Teacher", classTeacher]])("%s can read and save (scoped in the service)", async (_l, token) => {
  expect((await auth(request(app).get("/class-subject-scores?classId=1&subjectId=2"), token)).status).toBe(200);
  const res = await auth(request(app).post("/class-subject-scores"), token).send({ classId: 1, subjectId: 2, scores: [{}] });
  expect(res.status).toBe(200);
  expect(svc.saveOfficeSheet).toHaveBeenLastCalledWith(expect.objectContaining({ category: _l }), { classId: 1, subjectId: 2, scores: [{}] });
});

it("Accountants, portal tokens and no token are refused", async () => {
  for (const token of [accountant, teacher]) {
    expect((await auth(request(app).get("/class-subject-scores"), token)).status).toBe(403);
    expect((await auth(request(app).post("/class-subject-scores"), token).send({})).status).toBe(403);
  }
  expect((await request(app).post("/class-subject-scores").send({})).status).toBe(401);
  expect(svc.saveOfficeSheet).not.toHaveBeenCalled();
});
