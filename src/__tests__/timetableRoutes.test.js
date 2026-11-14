// B3: who may read and build the timetable. Service stubbed, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/timetable.js", () => ({
  __esModule: true,
  DAYS: [{ day: 1, label: "Monday", short: "Mon" }],
  listPeriods: jest.fn(async () => []),
  replacePeriods: jest.fn(async (p) => p),
  listTimetable: jest.fn(async () => []),
  createEntry: jest.fn(async (body, opts) => ({ entry: { ...body, ...opts }, warnings: [] })),
  updateEntry: jest.fn(async (id) => ({ entry: { id }, warnings: [] })),
  deleteEntry: jest.fn(async () => ({ deleted: 1 })),
  bulkCreateEntries: jest.fn(async () => ({ created: 0, warnings: [] })),
  copyTimetable: jest.fn(async () => ({ copied: 0 })),
  syncAssignmentsFromTimetable: jest.fn(async () => ({ set: 0 })),
  getPortalTimetable: jest.fn(async (user) => ({ user })),
}));

const app = require("../index.js").default;
const svc = require("../services/timetable.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const teacher = sign({ id: "3", userRole: "STAFF" });
const student = sign({ id: 7, userRole: "STU" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

describe("office /timetable", () => {
  it.each([["Administrator", admin], ["Class Teacher", classTeacher], ["Accountant", accountant]])(
    "%s can read the timetable and bell schedule",
    async (_l, token) => {
      expect((await auth(request(app).get("/timetable?termId=2&classId=1"), token)).status).toBe(200);
      const res = await auth(request(app).get("/timetable/periods"), token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ days: [{ day: 1, label: "Monday", short: "Mon" }], periods: [] });
    }
  );

  it("Administrator builds it; the server records who", async () => {
    const res = await auth(request(app).post("/timetable"), admin).send({ classId: 1 });
    expect(res.status).toBe(200);
    expect(svc.createEntry).toHaveBeenCalledWith({ classId: 1 }, { createdBy: "admin" });
    expect((await auth(request(app).put("/timetable/periods"), admin).send({ periods: [] })).status).toBe(200);
    expect(svc.replacePeriods).toHaveBeenCalledWith([]);
    expect((await auth(request(app).put("/timetable/5"), admin).send({})).status).toBe(200);
    expect(svc.updateEntry).toHaveBeenCalledWith("5", {}, { createdBy: "admin" });
  });

  it.each([
    ["post", "/timetable"],
    ["put", "/timetable/5"],
    ["delete", "/timetable/5"],
    ["put", "/timetable/periods"],
    ["post", "/timetable/bulk"],
    ["post", "/timetable/copy"],
    ["post", "/timetable/sync-assignments"],
  ])("Class Teacher and Accountant can't %s %s (403)", async (method, path) => {
    for (const token of [classTeacher, accountant]) {
      expect((await auth(request(app)[method](path), token).send({})).status).toBe(403);
    }
  });

  it("portal tokens can't use the office routes (403)", async () => {
    expect((await auth(request(app).get("/timetable?termId=2&classId=1"), teacher)).status).toBe(403);
  });
});

describe("portal /portal/timetable", () => {
  it.each([["teacher", teacher, "STAFF"], ["student", student, "STU"]])("a %s gets their own", async (_l, token, role) => {
    const res = await auth(request(app).get("/portal/timetable"), token);
    expect(res.status).toBe(200);
    expect(res.body.user.userRole).toBe(role);
  });
  it("an office token falls through and is not served here", async () => {
    expect((await auth(request(app).get("/portal/timetable"), admin)).status).toBe(404);
  });
  it("no token = 401", async () => {
    expect((await request(app).get("/portal/timetable")).status).toBe(401);
  });
});
