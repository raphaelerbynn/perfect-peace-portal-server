// B4: who may read whole-class report cards. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/reportCards.js", () => ({
  __esModule: true,
  getCompleteness: jest.fn(async (q, user) => ({ q, user: user.category })),
  getClassReportCards: jest.fn(async (q) => ({ q, cards: [] })),
}));

const app = require("../index.js").default;
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin" });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc" });
const portalTeacher = sign({ id: "3", userRole: "STAFF" });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

it.each([["Administrator", admin], ["Class Teacher", classTeacher]])("%s can read them (the service scopes the class)", async (role, token) => {
  const res = await auth(request(app).get("/report-cards/completeness?classId=1&termId=5"), token);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ q: { classId: "1", termId: "5" }, user: role });
  expect((await auth(request(app).get("/report-cards/class?classId=1&termId=5"), token)).status).toBe(200);
});

it.each([["Accountant", accountant], ["portal teacher", portalTeacher]])("%s is refused (403)", async (_l, token) => {
  expect((await auth(request(app).get("/report-cards/class?classId=1&termId=5"), token)).status).toBe(403);
});
