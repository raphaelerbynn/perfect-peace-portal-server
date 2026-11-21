// B11: who may read the academic reports. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/academicReports.js", () => ({
  __esModule: true,
  getTermsOverview: jest.fn(async () => ({ terms: [] })),
  getTermReport: jest.fn(async (termId) => ({ termId })),
  getClassTermReport: jest.fn(async (q, user) => ({ q, user: user.category })),
}));

const app = require("../index.js").default;
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin" });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc" });
const portalTeacher = sign({ id: "3", userRole: "STAFF" });
const pupil = sign({ id: "9", userRole: "STUDENT" });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

it("the Administrator reads the school-wide reports", async () => {
  const a = await auth(request(app).get("/reports/academic/terms-overview"), admin);
  expect(a.status).toBe(200);
  expect(a.body).toEqual({ terms: [] });
  const b = await auth(request(app).get("/reports/academic/term/13"), admin);
  expect(b.status).toBe(200);
  expect(b.body).toEqual({ termId: "13" });
});

it.each([["Class Teacher", classTeacher], ["Accountant", accountant], ["portal teacher", portalTeacher], ["pupil", pupil]])(
  "%s may not read the school-wide reports (403)",
  async (_l, token) => {
    expect((await auth(request(app).get("/reports/academic/terms-overview"), token)).status).toBe(403);
    expect((await auth(request(app).get("/reports/academic/term/13"), token)).status).toBe(403);
  }
);

it.each([["Administrator", admin], ["Class Teacher", classTeacher]])("%s reads one class (the service scopes it)", async (role, token) => {
  const r = await auth(request(app).get("/reports/academic/term/13/class/2"), token);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ q: { termId: "13", classId: "2" }, user: role });
});

it.each([["Accountant", accountant], ["portal teacher", portalTeacher], ["pupil", pupil]])("%s may not read a class (403)", async (_l, token) => {
  expect((await auth(request(app).get("/reports/academic/term/13/class/2"), token)).status).toBe(403);
});

it("no token: 401", async () => {
  expect((await request(app).get("/reports/academic/terms-overview")).status).toBe(401);
});
