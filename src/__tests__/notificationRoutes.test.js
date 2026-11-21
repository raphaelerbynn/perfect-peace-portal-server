// B16: who reaches the notification routes (service stubbed, no DB).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/notify.js", () => {
  const real = jest.requireActual("../services/notify.js");
  const echo = (name) => jest.fn(async (...args) => ({ name, args }));
  return {
    __esModule: true,
    recipientOf: real.recipientOf,
    listNotifications: echo("list"),
    unreadCount: echo("unread"),
    markRead: echo("read"),
    markAllRead: echo("readAll"),
    getNotificationSettings: echo("settings"),
    updateNotificationSettings: echo("saveSettings"),
    listEmailLog: echo("emailLog"),
    sendResultsReady: echo("resultsReady"),
    sendScoresReminder: echo("scoresReminder"),
    notifyPostPublished: jest.fn(),
    notifyPaymentRecorded: jest.fn(),
    notifyAbsences: jest.fn(),
    notifyPasswordChanged: jest.fn(),
  };
});

const app = require("../index.js").default;
const svc = require("../services/notify.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const student = sign({ id: 7, userRole: "STU" });
const teacher = sign({ id: 3, userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const accountant = sign({ category: "Accountant", username: "acc", teacherId: null });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

beforeEach(() => jest.clearAllMocks());

describe("own notifications", () => {
  it.each([
    ["pupil", student, { type: "STUDENT", id: "7" }],
    ["teacher", teacher, { type: "STAFF", id: "3" }],
    ["office", accountant, { type: "OFFICE", id: "acc" }],
  ])("a %s reads only their own (recipient from the token)", async (_l, t, rec) => {
    const res = await auth(request(app).get("/notifications?unreadOnly=true&recipientId=99"), t);
    expect(res.status).toBe(200);
    expect(svc.listNotifications).toHaveBeenCalledWith(rec, expect.objectContaining({ unreadOnly: "true" }));
    await auth(request(app).get("/notifications/unread-count"), t);
    expect(svc.unreadCount).toHaveBeenCalledWith(rec);
    await auth(request(app).patch("/notifications/12/read"), t);
    expect(svc.markRead).toHaveBeenCalledWith(rec, "12");
    await auth(request(app).patch("/notifications/read-all"), t);
    expect(svc.markAllRead).toHaveBeenCalledWith(rec);
  });

  it("no token = 401; unknown portal role or office token without username = 403", async () => {
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await auth(request(app).get("/notifications"), sign({ id: 1, userRole: "PARENT" }))).status).toBe(403);
    expect((await auth(request(app).get("/notifications/unread-count"), sign({ category: "Administrator" }))).status).toBe(403);
    expect(svc.listNotifications).not.toHaveBeenCalled();
  });
});

describe("office actions", () => {
  it("switches and email log: Administrator only", async () => {
    for (const t of [student, teacher, accountant, classTeacher]) {
      expect((await auth(request(app).get("/notification-settings"), t)).status).toBe(403);
      expect((await auth(request(app).put("/notification-settings").send({ types: [] }), t)).status).toBe(403);
      expect((await auth(request(app).get("/notifications/email-log"), t)).status).toBe(403);
    }
    expect((await auth(request(app).get("/notification-settings"), admin)).status).toBe(200);
    const put = await auth(request(app).put("/notification-settings").send({ types: [{ type: "NEWS_POST", inApp: true, email: false }] }), admin);
    expect(put.status).toBe(200);
    expect(svc.updateNotificationSettings).toHaveBeenCalledWith({ types: [{ type: "NEWS_POST", inApp: true, email: false }] }, { username: "admin" });
    expect((await auth(request(app).get("/notifications/email-log"), admin)).status).toBe(200);
    expect(svc.markRead).not.toHaveBeenCalled();
  });

  it("results ready: Administrator and Class Teacher (class checked in the service); not Accountant or portal", async () => {
    expect((await auth(request(app).post("/notifications/results-ready").send({ classId: 3, termId: 9 }), accountant)).status).toBe(403);
    expect((await auth(request(app).post("/notifications/results-ready").send({ classId: 3, termId: 9 }), teacher)).status).toBe(403);
    expect((await auth(request(app).post("/notifications/results-ready").send({ classId: 3, termId: 9 }), classTeacher)).status).toBe(200);
    expect(svc.sendResultsReady).toHaveBeenCalledWith({ classId: 3, termId: 9 }, expect.objectContaining({ category: "Class Teacher", username: "ct" }));
  });

  it("scores reminder: Administrator only", async () => {
    expect((await auth(request(app).post("/notifications/scores-reminder"), classTeacher)).status).toBe(403);
    expect((await auth(request(app).post("/notifications/scores-reminder"), teacher)).status).toBe(403);
    expect((await auth(request(app).post("/notifications/scores-reminder"), admin)).status).toBe(200);
  });
});
