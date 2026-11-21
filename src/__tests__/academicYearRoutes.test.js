// B7: who may read and change academic years. Services stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/academicYear.js", () => ({
  __esModule: true,
  listYears: jest.fn(async () => ({ years: [], unassignedTerms: [] })),
  getYear: jest.fn(async (id) => ({ academicYearId: Number(id) })),
  createYear: jest.fn(async (b) => b),
  updateYear: jest.fn(async (id, b) => ({ id, ...b })),
  deleteYear: jest.fn(async () => ({ deleted: true })),
  setCurrentYear: jest.fn(async (id) => ({ academicYearId: Number(id), isCurrent: true })),
  assertTermFitsYear: jest.fn(),
  resolveTermYear: jest.fn(),
  termName: (t) => `Term ${t.term}`,
}));

const app = require("../index.js").default;
const svc = require("../services/academicYear.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const student = sign({ id: 7, userRole: "STU" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

it.each([["Administrator", admin], ["Class Teacher", classTeacher], ["Accountant", accountant]])("%s can read the years", async (_l, t) => {
  expect((await auth(request(app).get("/academic-years"), t)).status).toBe(200);
});

it("portal tokens and no token are refused", async () => {
  expect((await auth(request(app).get("/academic-years"), student)).status).toBe(403);
  expect((await request(app).get("/academic-years")).status).toBe(401);
});

it.each([
  ["post", "/academic-years"],
  ["patch", "/academic-years/1"],
  ["delete", "/academic-years/1"],
  ["post", "/academic-years/1/set-current"],
  ["post", "/academic-years/1/terms"],
  ["post", "/terms/3/activate"],
  ["delete", "/terms/3"],
])("only an Administrator may %s %s", async (method, path) => {
  for (const t of [classTeacher, accountant]) {
    expect((await auth(request(app)[method](path), t).send({})).status).toBe(403);
  }
});

it("Administrator creates and makes current", async () => {
  expect((await auth(request(app).post("/academic-years"), admin).send({ name: "2027/2028" })).status).toBe(200);
  expect(svc.createYear).toHaveBeenCalledWith({ name: "2027/2028" });
  const res = await auth(request(app).post("/academic-years/2/set-current"), admin);
  expect(res.body).toEqual({ academicYearId: 2, isCurrent: true });
});
