// B9: who may use staff attendance. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/staffAttendance.js", () => ({
  __esModule: true,
  getStaffDay: jest.fn(async (date) => ({ date, staff: [] })),
  saveStaffDay: jest.fn(async (body) => ({ date: body.date, saved: 1, removed: 0 })),
  getStaffSummary: jest.fn(async () => ({ staff: [] })),
  getOneStaffSummary: jest.fn(async (id) => ({ teacher: { teacherId: Number(id) } })),
}));

const app = require("../index.js").default;
const svc = require("../services/staffAttendance.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const admin = sign({ category: "Administrator", username: "head", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const student = sign({ id: 7, userRole: "STU" });
const staffPortal = sign({ id: 3, userRole: "STAFF" });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

const ROUTES = [
  ["get", "/staff-attendance?date=2026-11-13"],
  ["post", "/staff-attendance"],
  ["get", "/staff-attendance/summary"],
  ["get", "/staff-attendance/3/summary"],
];

it.each(ROUTES)("only an Administrator may %s %s", async (method, path) => {
  for (const t of [classTeacher, accountant, student, staffPortal]) {
    expect((await auth(request(app)[method](path), t).send({})).status).toBe(403);
  }
  expect((await request(app)[method](path)).status).toBe(401);
});

it("Administrator saves; the marker comes from the token, not the body", async () => {
  const res = await auth(request(app).post("/staff-attendance"), admin).send({ date: "2026-11-13", entries: [{ teacherId: 3, status: "PRESENT" }], markedBy: "someone" });
  expect(res.status).toBe(200);
  expect(svc.saveStaffDay).toHaveBeenCalledWith(
    expect.objectContaining({ date: "2026-11-13" }),
    expect.objectContaining({ username: "head", category: "Administrator" })
  );
});

it("Administrator reads a day and the summaries", async () => {
  expect((await auth(request(app).get("/staff-attendance?date=2026-11-13"), admin)).body).toEqual({ date: "2026-11-13", staff: [] });
  expect((await auth(request(app).get("/staff-attendance/summary?termId=9"), admin)).status).toBe(200);
  expect(svc.getStaffSummary).toHaveBeenCalledWith(expect.objectContaining({ termId: "9" }));
  const one = await auth(request(app).get("/staff-attendance/3/summary"), admin);
  expect(one.body).toEqual({ teacher: { teacherId: 3 } });
  expect(svc.getOneStaffSummary).toHaveBeenCalledWith("3", expect.anything());
});
