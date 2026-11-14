// B16: notifications (models mocked, no DB): notify never throws, recipients
// cleaned, switches respected, scoping (nobody reads anyone else's), mark read
// / read all, triggers, the email queue (daily cap, one bad address fails alone).
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({})), query: jest.fn() },
}));
jest.mock("../services/school.js", () => ({
  __esModule: true,
  getSchoolSettings: jest.fn(async () => ({ name: "PERFECT PEACE PREPARATORY SCHOOL", shortName: "Perfect Peace", phones: "024", email: "school@example.com" })),
}));
jest.mock("../services/reportCards.js", () => ({ __esModule: true, getCompleteness: jest.fn() }));
jest.mock("../services/mailer.js", () => {
  const real = jest.requireActual("../services/mailer.js");
  return { __esModule: true, ...real, sendMail: jest.fn(real.sendMail), mailConfig: jest.fn(real.mailConfig) };
});
jest.mock("../models/index.js", () => {
  const model = () => ({
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findByPk: jest.fn(async () => null),
    findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
    bulkCreate: jest.fn(async (rows) => rows),
    create: jest.fn(async (v) => ({ ...v })),
    upsert: jest.fn(async () => [{}, true]),
    update: jest.fn(async () => [1]),
    count: jest.fn(async () => 0),
  });
  return {
    __esModule: true,
    Class: model(),
    EmailLog: model(),
    NotificationSetting: model(),
    Parent: model(),
    Student: model(),
    StudentMarks: model(),
    Subject: model(),
    Teacher: model(),
    TeachingAssignment: model(),
    Term: model(),
    UserAccount: model(),
    UserNotification: model(),
  };
});

import { Op } from "sequelize";
import * as M from "../models/index.js";
import * as N from "../services/notify.js";
import { mailConfig, sendMail } from "../services/mailer.js";
import { getCompleteness } from "../services/reportCards.js";
import { fakeTable, matches } from "../testSupport/fakeTable.js";

const { UserNotification, NotificationSetting, EmailLog, Student, Parent, Teacher, UserAccount, Class, TeachingAssignment, StudentMarks, Subject, Term } = M;

let rows;
const wireNotifications = () => {
  rows = [];
  fakeTable(UserNotification, rows, "notificationId");
  UserNotification.bulkCreate.mockImplementation(async (list) => {
    for (const r of list) rows.push({ notificationId: rows.length + 1, ...r });
    return list;
  });
  UserNotification.findAndCountAll.mockImplementation(async ({ where, limit, offset }) => {
    const hit = rows.filter((r) => matches(r, where)).sort((a, b) => b.notificationId - a.notificationId);
    return { rows: hit.slice(offset, offset + limit).map((r) => ({ ...r })), count: hit.length };
  });
};

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, EMAIL_DRIVER: "log" };
  N.clearNotifySettingsCache();
  const realMailer = jest.requireActual("../services/mailer.js");
  mailConfig.mockImplementation(realMailer.mailConfig);
  sendMail.mockImplementation(realMailer.sendMail);
  EmailLog.create.mockImplementation(async (v) => ({ ...v }));
  EmailLog.count.mockResolvedValue(0);
  NotificationSetting.findAll.mockResolvedValue([]);
  wireNotifications();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  process.env = ENV;
});

describe("notify()", () => {
  it("writes one in-app row per recipient, deduped, empty / bad ones dropped", async () => {
    const res = await N.notify({
      type: "NEWS_POST",
      title: "Sports day",
      recipients: [{ type: "STUDENT", id: 7 }, { type: "STUDENT", id: "7" }, { type: "STAFF", id: "" }, { type: "PARENT", id: 1 }, null, { type: "OFFICE", id: "admin" }],
      link: (t) => (t === "OFFICE" ? "/news" : "/"),
    });
    expect(res.inApp).toBe(2);
    expect(rows.map((r) => [r.recipientType, r.recipientId, r.linkUrl])).toEqual([
      ["STUDENT", "7", "/"],
      ["OFFICE", "admin", "/news"],
    ]);
    expect(rows[0].readAt).toBeNull();
  });

  it("leaves out excluded recipients (the author)", async () => {
    await N.notify({ type: "NEWS_POST", title: "x", recipients: [{ type: "OFFICE", id: "admin" }, { type: "OFFICE", id: "acc" }], exclude: [{ type: "OFFICE", id: "admin" }] });
    expect(rows.map((r) => r.recipientId)).toEqual(["acc"]);
  });

  it("no recipients, unknown type or no title: nothing written", async () => {
    expect((await N.notify({ type: "NEWS_POST", title: "x", recipients: [] })).inApp).toBe(0);
    expect((await N.notify({ type: "NOPE", title: "x", recipients: [{ type: "STUDENT", id: 1 }] })).inApp).toBe(0);
    expect((await N.notify({ type: "NEWS_POST", title: "", recipients: [{ type: "STUDENT", id: 1 }] })).inApp).toBe(0);
    expect(UserNotification.bulkCreate).not.toHaveBeenCalled();
  });

  it("never throws: a failing database gives 0, the caller carries on", async () => {
    UserNotification.bulkCreate.mockRejectedValue(new Error("db down"));
    NotificationSetting.findAll.mockRejectedValue(new Error("no table"));
    await expect(N.notify({ type: "PAYMENT_RECORDED", title: "x", recipients: [{ type: "STUDENT", id: 1 }] })).resolves.toMatchObject({ inApp: 0 });
    await expect(N.notify()).resolves.toMatchObject({ inApp: 0 });
  });

  it("respects the in-app switch", async () => {
    NotificationSetting.findAll.mockResolvedValue([{ type: "NEWS_POST", inApp: false, email: false }]);
    expect((await N.notify({ type: "NEWS_POST", title: "x", recipients: [{ type: "STUDENT", id: 1 }] })).inApp).toBe(0);
    expect(rows).toHaveLength(0);
  });

  it("email: one per address (siblings share a parent), logged with EMAIL_DRIVER=log", async () => {
    Student.findAll.mockResolvedValue([{ studentId: 1, parentId: 9 }, { studentId: 2, parentId: 9 }, { studentId: 3, parentId: null }]);
    Parent.findAll.mockResolvedValue([{ parentId: 9, email: "mum@example.com" }]);
    const res = await N.notify({ type: "RESULTS_READY", title: "Results ready", body: "<b>hi</b>", recipients: [1, 2, 3].map((id) => ({ type: "STUDENT", id })), link: "/results" });
    expect(res.inApp).toBe(3);
    expect(res.emails).toBe(1);
    await res.done;
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(EmailLog.create).toHaveBeenCalledWith(expect.objectContaining({ status: "LOGGED", toAddress: "mum@example.com", notificationType: "RESULTS_READY" }));
  });

  it("email switched off: no address lookup, no email", async () => {
    const res = await N.notify({ type: "NEWS_POST", title: "x", recipients: [{ type: "STUDENT", id: 1 }] });
    expect(res.emails).toBe(0);
    expect(Student.findAll).not.toHaveBeenCalled();
  });

  it("EMAIL_DRIVER=off: no email at all", async () => {
    process.env.EMAIL_DRIVER = "off";
    const res = await N.notify({ type: "PAYMENT_RECORDED", title: "x", recipients: [{ type: "STUDENT", id: 1 }] });
    expect(res.inApp).toBe(1);
    expect(res.emails).toBe(0);
  });

  it("an email lookup failure still writes the in-app rows", async () => {
    Student.findAll.mockRejectedValue(new Error("boom"));
    const res = await N.notify({ type: "PAYMENT_RECORDED", title: "x", recipients: [{ type: "STUDENT", id: 1 }] });
    expect(res.inApp).toBe(1);
    expect(res.emails).toBe(0);
  });
});

describe("sendEmailBatch (Gmail-friendly)", () => {
  const job = (to) => ({ to, recipient: { type: "STAFF", id: "1" }, subject: "S", text: "t", html: "<p>t</p>" });
  const smtp = { driver: "smtp", smtp: {}, fromAddress: "a@b.co", fromName: "", batchSize: 2, batchPauseMs: 0 };

  it("one bad address fails alone, the rest are sent, each one logged", async () => {
    mailConfig.mockReturnValue({ ...smtp, dailyLimit: 0 });
    sendMail.mockImplementation(async ({ to }) => (to === "bad@x.co" ? { status: "FAILED", error: "550 no such user" } : { status: "SENT" }));
    const res = await N.sendEmailBatch("PAYMENT_RECORDED", [job("a@x.co"), job("bad@x.co"), job("c@x.co")]);
    expect(res).toEqual({ sent: 2, logged: 0, failed: 1 });
    expect(EmailLog.create).toHaveBeenCalledTimes(3);
    expect(EmailLog.create).toHaveBeenCalledWith(expect.objectContaining({ toAddress: "bad@x.co", status: "FAILED", error: "550 no such user" }));
  });

  it("stops at the daily limit; the rest are logged as not sent", async () => {
    mailConfig.mockReturnValue({ ...smtp, dailyLimit: 450 });
    EmailLog.count.mockResolvedValue(449);
    sendMail.mockResolvedValue({ status: "SENT" });
    const res = await N.sendEmailBatch("NEWS_POST", [job("a@x.co"), job("b@x.co"), job("c@x.co")]);
    expect(res).toEqual({ sent: 1, logged: 0, failed: 2 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(EmailLog.count).toHaveBeenCalledWith({ where: { status: "SENT", createdAt: { [Op.gte]: expect.any(Date) } } });
  });

  it("password-change emails are not held back by the daily limit", async () => {
    mailConfig.mockReturnValue({ ...smtp, dailyLimit: 450 });
    EmailLog.count.mockResolvedValue(450);
    sendMail.mockResolvedValue({ status: "SENT" });
    expect(await N.sendEmailBatch("PASSWORD_CHANGED", [job("a@x.co")])).toEqual({ sent: 1, logged: 0, failed: 0 });
    expect(await N.sendEmailBatch("RESULTS_READY", [job("a@x.co")])).toEqual({ sent: 0, logged: 0, failed: 1 });
  });

  it("a failing log write doesn't stop the batch", async () => {
    mailConfig.mockReturnValue({ ...smtp, dailyLimit: 0 });
    sendMail.mockResolvedValue({ status: "SENT" });
    EmailLog.create.mockRejectedValue(new Error("db"));
    await expect(N.sendEmailBatch("NEWS_POST", [job("a@x.co"), job("b@x.co")])).resolves.toEqual({ sent: 2, logged: 0, failed: 0 });
  });
});

describe("the caller's own notifications", () => {
  const ama = { type: "STUDENT", id: "7" };
  const kofi = { type: "STAFF", id: "7" }; // same number, other kind of login
  const seed = () => {
    const t = (m) => new Date(Date.UTC(2026, 10, 14, 8, m));
    rows.push(
      { notificationId: 1, recipientType: "STUDENT", recipientId: "7", type: "NEWS_POST", title: "a", readAt: null, createdAt: t(1) },
      { notificationId: 2, recipientType: "STUDENT", recipientId: "7", type: "NEWS_POST", title: "b", readAt: t(5), createdAt: t(2) },
      { notificationId: 3, recipientType: "STAFF", recipientId: "7", type: "SCORES_MISSING", title: "c", readAt: null, createdAt: t(3) },
      { notificationId: 4, recipientType: "STUDENT", recipientId: "8", type: "NEWS_POST", title: "d", readAt: null, createdAt: t(4) }
    );
  };

  it("recipient comes from the token", () => {
    expect(N.recipientOf({ id: 7, userRole: "STU" })).toEqual({ type: "STUDENT", id: "7" });
    expect(N.recipientOf({ id: 3, userRole: "STAFF" })).toEqual({ type: "STAFF", id: "3" });
    expect(N.recipientOf({ category: "Accountant", username: "acc" })).toEqual({ type: "OFFICE", id: "acc" });
    expect(() => N.recipientOf({ id: 1, userRole: "PARENT" })).toThrow();
    expect(() => N.recipientOf({ category: "Administrator" })).toThrow();
  });

  it("lists only mine, newest first; unread counts all mine whatever the filter", async () => {
    seed();
    const all = await N.listNotifications(ama, {});
    expect(all.notifications.map((n) => n.notificationId)).toEqual([2, 1]);
    expect(all.unread).toBe(1);
    const unread = await N.listNotifications(ama, { unreadOnly: "true" });
    expect(unread.notifications.map((n) => n.notificationId)).toEqual([1]);
    expect(unread.unread).toBe(1);
    expect((await N.listNotifications(kofi, {})).notifications.map((n) => n.notificationId)).toEqual([3]);
  });

  it("cursor paging: rows read in between don't shift the next page", async () => {
    for (let i = 1; i <= 5; i++) rows.push({ notificationId: i, recipientType: "STUDENT", recipientId: "7", type: "NEWS_POST", title: `n${i}`, readAt: null, createdAt: new Date() });
    const first = await N.listNotifications(ama, { unreadOnly: "true", limit: "2" });
    expect(first.notifications.map((n) => n.notificationId)).toEqual([5, 4]);
    expect(first.hasMore).toBe(true);
    await N.markRead(ama, 5);
    const next = await N.listNotifications(ama, { unreadOnly: "true", limit: "2", before: "4" });
    expect(next.notifications.map((n) => n.notificationId)).toEqual([3, 2]);
    expect(next.hasMore).toBe(true);
    const last = await N.listNotifications(ama, { unreadOnly: "true", limit: "2", before: "2" });
    expect(last.notifications.map((n) => n.notificationId)).toEqual([1]);
    expect(last.hasMore).toBe(false);
  });

  it("limit capped at 100, rubbish falls back to 20 / page 1", async () => {
    await N.listNotifications(ama, { limit: "5000", page: "-3" });
    expect(UserNotification.findAndCountAll).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 0 }));
    await N.listNotifications(ama, { limit: "abc", page: "2" });
    expect(UserNotification.findAndCountAll).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 20 }));
  });

  it("can't mark someone else's (same number, other login kind) - 404", async () => {
    seed();
    await expect(N.markRead(ama, 3)).rejects.toMatchObject({ statusCode: 404 });
    await expect(N.markRead(ama, 4)).rejects.toMatchObject({ statusCode: 404 });
    await expect(N.markRead(ama, "abc")).rejects.toMatchObject({ statusCode: 404 });
    expect(rows.find((r) => r.notificationId === 3).readAt).toBeNull();
  });

  it("mark read is idempotent: the first read time stays", async () => {
    seed();
    const first = await N.markRead(ama, 1);
    expect(first.readAt).not.toBeNull();
    const firstAt = rows.find((r) => r.notificationId === 1).readAt;
    const again = await N.markRead(ama, 1);
    expect(again.readAt).toBe(new Date(firstAt).toISOString());
    const already = await N.markRead(ama, 2);
    expect(already.readAt).toBe(new Date(Date.UTC(2026, 10, 14, 8, 5)).toISOString());
  });

  it("read all touches only my unread rows and says how many", async () => {
    seed();
    expect(await N.markAllRead(ama)).toEqual({ count: 1 });
    expect(rows.find((r) => r.notificationId === 3).readAt).toBeNull();
    expect(rows.find((r) => r.notificationId === 4).readAt).toBeNull();
    expect((await N.unreadCount(ama)).unread).toBe(0);
    expect((await N.unreadCount(kofi)).unread).toBe(1);
  });
});

describe("settings", () => {
  it("lists every type with defaults, overridden by saved rows; no SMTP secret", async () => {
    process.env.SMTP_PASS = "secret";
    NotificationSetting.findAll.mockResolvedValue([{ type: "NEWS_POST", inApp: false, email: true }]);
    const s = await N.getNotificationSettings();
    expect(s.types.find((t) => t.type === "NEWS_POST")).toMatchObject({ inApp: false, email: true });
    expect(s.types.find((t) => t.type === "PAYMENT_RECORDED")).toMatchObject({ inApp: true, email: true });
    expect(s.email.driver).toBe("log");
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("saves valid switches, refuses unknown types and non-booleans", async () => {
    await N.updateNotificationSettings({ types: [{ type: "NEWS_POST", inApp: true, email: true }] }, { username: "admin" });
    expect(NotificationSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ type: "NEWS_POST", inApp: true, email: true, updatedBy: "admin" }));
    await expect(N.updateNotificationSettings({ types: [{ type: "X", inApp: true, email: true }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(N.updateNotificationSettings({ types: [{ type: "NEWS_POST", inApp: "yes", email: true }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(N.updateNotificationSettings({})).rejects.toMatchObject({ statusCode: 400 });
  });

  it("types whose in-app row is the 'already sent' record can't lose in-app", async () => {
    await expect(N.updateNotificationSettings({ types: [{ type: "ATTENDANCE_ABSENT", inApp: false, email: true }] })).rejects.toMatchObject({ statusCode: 400 });
    NotificationSetting.findAll.mockResolvedValue([{ type: "RESULTS_READY", inApp: false, email: true }]); // an old row
    const s = await N.getNotificationSettings();
    expect(s.types.find((t) => t.type === "RESULTS_READY")).toMatchObject({ inApp: true, inAppLocked: true });
    expect(s.types.find((t) => t.type === "NEWS_POST").inAppLocked).toBe(false);
  });
});

describe("triggers", () => {
  it("news ALL: pupils, teachers and office, not the author", async () => {
    Student.findAll.mockResolvedValue([{ studentId: 1 }, { studentId: 2 }]);
    Teacher.findAll.mockResolvedValue([{ teacherId: 5 }]);
    UserAccount.findAll.mockResolvedValue([{ username: "admin" }, { username: "acc" }]);
    await N.notifyPostPublished({ eventId: 10, name: "Sports day", description: "Come", audience: "ALL", createdBy: "admin", postType: "EVENT" });
    expect(rows.map((r) => `${r.recipientType}:${r.recipientId}`).sort()).toEqual(["OFFICE:acc", "STAFF:5", "STUDENT:1", "STUDENT:2"]);
    expect(rows[0]).toMatchObject({ title: "New event: Sports day", entityType: "post", entityId: "10" });
  });

  it("news CLASSES: only those classes' pupils and their class teachers", async () => {
    Student.findAll.mockResolvedValue([{ studentId: 1 }]);
    Class.findAll.mockResolvedValue([{ teacherId: 4 }, { teacherId: null }]);
    await N.notifyPostPublished({ eventId: 11, name: "Trip", audience: "CLASSES", audienceClassIds: [3], createdBy: "ct" });
    expect(Student.findAll.mock.calls[0][0].where).toMatchObject({ isDeleted: false, classId: { [Op.in]: [3] } });
    expect(rows.map((r) => `${r.recipientType}:${r.recipientId}`).sort()).toEqual(["STAFF:4", "STUDENT:1"]);
    expect(Teacher.findAll).not.toHaveBeenCalled();
  });

  it("news STAFF: no pupils", async () => {
    Teacher.findAll.mockResolvedValue([{ teacherId: 5 }]);
    UserAccount.findAll.mockResolvedValue([]);
    await N.notifyPostPublished({ eventId: 12, name: "Staff meeting", audience: "STAFF" });
    expect(Student.findAll).not.toHaveBeenCalled();
    expect(rows.map((r) => r.recipientType)).toEqual(["STAFF"]);
  });

  it("payment: server amounts, credit shown as credit", async () => {
    Student.findByPk.mockResolvedValue({ studentId: 7, fName: "Ama", lName: "Owusu" });
    await N.notifyPaymentRecorded({ studentId: 7, paid: 300, owing: -50, receiptNo: "R-0001", feeId: 99 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientType: "STUDENT", recipientId: "7", linkUrl: "/fees", entityId: "99" });
    expect(rows[0].title).toBe("Payment received: GH₵ 300.00");
    expect(rows[0].body).toContain("GH₵ 50.00 in credit");
    expect(rows[0].body).toContain("R-0001");
  });

  it("absence: only pupils marked absent (padded CHAR status), once per day", async () => {
    Student.findAll.mockImplementation(async ({ where }) => where.studentId[Op.in].map((id) => ({ studentId: id, fName: `P${id}` })));
    const marks = [{ studentId: 1, status: "absent    " }, { studentId: 2, status: "present" }, { studentId: 3, status: "Absent" }];
    await N.notifyAbsences(marks, "2026-11-13");
    expect(rows.map((r) => r.recipientId).sort()).toEqual(["1", "3"]);
    await N.notifyAbsences(marks, "2026-11-13");
    expect(rows).toHaveLength(2);
    await N.notifyAbsences(marks, "2026-11-14");
    expect(rows).toHaveLength(4);
  });

  it("password changed: office reset by staff id reaches that login", async () => {
    UserAccount.findAll.mockResolvedValue([{ username: "kofi" }]);
    await N.notifyPasswordChanged({ type: "OFFICE", teacherId: 3 });
    expect(rows).toMatchObject([{ recipientType: "OFFICE", recipientId: "kofi", type: "PASSWORD_CHANGED" }]);
    await N.notifyPasswordChanged({ type: "STUDENT", id: 7 });
    expect(rows[1]).toMatchObject({ recipientType: "STUDENT", recipientId: "7" });
  });

  it("triggers never throw", async () => {
    Student.findAll.mockRejectedValue(new Error("x"));
    Student.findByPk.mockRejectedValue(new Error("x"));
    UserAccount.findAll.mockRejectedValue(new Error("x"));
    await expect(N.notifyPostPublished({ eventId: 1, name: "a", audience: "ALL" })).resolves.toBeNull();
    await expect(N.notifyPaymentRecorded({ studentId: 1, paid: 1, owing: 0 })).resolves.toBeNull();
    await expect(N.notifyAbsences([{ studentId: 1, status: "absent" }], "2026-11-13")).resolves.toBeNull();
    await expect(N.notifyPasswordChanged({ type: "OFFICE", teacherId: 1 })).resolves.toBeNull();
  });
});

describe("office actions", () => {
  it("results ready: pupils with results only, scoped by the report-card check, no repeat within the hour", async () => {
    getCompleteness.mockResolvedValue({
      class: { classId: 3, name: "Basic 4" },
      term: { termId: 9, term: "1" },
      complete: false,
      students: [{ studentId: 1, hasResult: true }, { studentId: 2, hasResult: false }],
    });
    const res = await N.sendResultsReady({ classId: 3, termId: 9 }, { category: "Class Teacher", username: "ct" });
    expect(getCompleteness).toHaveBeenCalledWith({ classId: 3, termId: 9 }, { category: "Class Teacher", username: "ct" });
    expect(res).toMatchObject({ notified: 1, pupils: 1, complete: false });
    expect(rows[0]).toMatchObject({ recipientId: "1", linkUrl: "/results", entityType: "class-term", entityId: "3:9", title: "Results ready: Term 1" });
    await expect(N.sendResultsReady({ classId: 3, termId: 9 }, {})).rejects.toMatchObject({ statusCode: 409 });
    // another (old) term of the same class within the hour: refused too
    getCompleteness.mockResolvedValue({ class: { classId: 3, name: "Basic 4" }, term: { termId: 2, term: "3" }, students: [{ studentId: 1, hasResult: true }] });
    await expect(N.sendResultsReady({ classId: 3, termId: 2 }, {})).rejects.toMatchObject({ statusCode: 409 });
    // class 33 is not class 3
    getCompleteness.mockResolvedValue({ class: { classId: 33, name: "JHS 3" }, term: { termId: 9, term: "1" }, students: [{ studentId: 5, hasResult: true }] });
    await expect(N.sendResultsReady({ classId: 33, termId: 9 }, {})).resolves.toMatchObject({ notified: 1 });
  });

  it("results ready: two clicks at once send once", async () => {
    getCompleteness.mockResolvedValue({ class: { classId: 4, name: "B5" }, term: { termId: 9, term: "1" }, students: [{ studentId: 1, hasResult: true }] });
    const [a, b] = await Promise.allSettled([N.sendResultsReady({ classId: 4, termId: 9 }, {}), N.sendResultsReady({ classId: 4, termId: 9 }, {})]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rows.filter((r) => r.type === "RESULTS_READY")).toHaveLength(1);
  });

  it("results ready: someone else's class is refused by the report-card check", async () => {
    getCompleteness.mockRejectedValue(Object.assign(new Error("own class only"), { statusCode: 403 }));
    await expect(N.sendResultsReady({ classId: 4, termId: 9 }, {})).rejects.toMatchObject({ statusCode: 403 });
    expect(rows).toHaveLength(0);
  });

  it("results ready: nobody has results yet = 400", async () => {
    getCompleteness.mockResolvedValue({ class: { classId: 3 }, term: { termId: 9 }, students: [{ studentId: 1, hasResult: false }] });
    await expect(N.sendResultsReady({ classId: 3, termId: 9 }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it("scores reminder: teachers with gaps only, KG left out, grouped per teacher", async () => {
    Term.findOne.mockResolvedValue({ termId: 9, term: "Term 1", active: true });
    TeachingAssignment.findAll.mockResolvedValue([
      { teacherId: 4, classId: 3, subjectId: 1 },
      { teacherId: 4, classId: 3, subjectId: 2 },
      { teacherId: 5, classId: 3, subjectId: 3 },
      { teacherId: 6, classId: 8, subjectId: 1 },
    ]);
    Class.findAll.mockResolvedValue([{ classId: 3, name: "Basic 4", section: "Primary" }, { classId: 8, name: "KG 1", section: "KG" }]);
    Student.findAll.mockResolvedValue([{ studentId: 1, classId: 3 }, { studentId: 2, classId: 3 }, { studentId: 9, classId: 8 }]);
    StudentMarks.findAll.mockResolvedValue([{ studentId: 1, subjectId: 1 }, { studentId: 2, subjectId: 1 }, { studentId: 1, subjectId: 2 }, { studentId: 1, subjectId: 3 }, { studentId: 2, subjectId: 3 }]);
    Subject.findAll.mockResolvedValue([{ subjectId: 2, name: "Science" }]);
    const res = await N.sendScoresReminder();
    expect(res).toMatchObject({ teachers: 1, notified: 1, gaps: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipientType: "STAFF", recipientId: "4", linkUrl: "/scores" });
    expect(rows[0].body).toContain("Science - Basic 4: 1 of 2 pupils");
  });

  it("term label", () => {
    expect(N.termLabel("2")).toBe("Term 2");
    expect(N.termLabel("Term 3")).toBe("Term 3");
  });

  it("scores reminder: no open term = 409", async () => {
    Term.findOne.mockResolvedValue(null);
    await expect(N.sendScoresReminder()).rejects.toMatchObject({ statusCode: 409 });
  });
});
