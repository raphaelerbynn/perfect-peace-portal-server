// B7: who may read whole-year results and attendance summaries. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/yearReports.js", () => ({
  __esModule: true,
  getClassYearResults: jest.fn(async (q, user) => ({ q, user: user.category })),
  getClassAttendanceSummary: jest.fn(async (q, user) => ({ q, user: user.category })),
}));

const app = require("../index.js").default;
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin" });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc" });
const portalTeacher = sign({ id: "3", userRole: "STAFF" });
const pupil = sign({ id: "9", userRole: "STUDENT" });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

it.each([["Administrator", admin], ["Class Teacher", classTeacher]])("%s can read them (the service scopes the class)", async (role, token) => {
  const a = await auth(request(app).get("/class-results/year?classId=1&academicYearId=5"), token);
  expect(a.status).toBe(200);
  expect(a.body).toEqual({ q: { classId: "1", academicYearId: "5" }, user: role });
  const b = await auth(request(app).get("/attendance-summary?classId=1&termId=5"), token);
  expect(b.status).toBe(200);
  expect(b.body.user).toBe(role);
});

it.each([["Accountant", accountant], ["portal teacher", portalTeacher], ["pupil", pupil]])("%s is refused (403)", async (_l, token) => {
  expect((await auth(request(app).get("/class-results/year?classId=1&academicYearId=5"), token)).status).toBe(403);
  expect((await auth(request(app).get("/attendance-summary?classId=1&academicYearId=5"), token)).status).toBe(403);
});

it("no token: 401", async () => {
  expect((await request(app).get("/attendance-summary?classId=1&termId=5")).status).toBe(401);
});
