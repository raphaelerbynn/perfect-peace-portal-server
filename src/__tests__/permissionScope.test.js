// B10: the reach permissions, through the real routes and helpers.
//   academics.all_classes        on: every class; off: the login's own class.
//   academics.edit_closed_terms  on: closed terms and any day's register;
//                                off: the open term only.
//   staff.view_sensitive         bank / payroll fields on the staff list.
//   news.manage / news.post      the feed's manager vs. own posts.
// A school-made "Head Teacher" role (custom, roleId 7) is the example: every
// academic job for every class, open term only, staff list without payroll,
// news manager. The Class Teacher system role keeps own-class scoping. The
// data services are stubbed and the models spied on: no database.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../services/term.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/term.js"),
  getTerm: jest.fn(async () => ({ termId: 5, startDate: "2026-09-08", endDate: "2026-12-18" })),
}));
jest.mock("../services/results.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/results.js"),
  getClassResult: jest.fn(async () => [{ dataValues: { studentId: 20 } }]),
  getClassMarks: jest.fn(async () => [{ studentId: 20, subjectId: 4 }]),
  upsertMarksResult: jest.fn(async (v) => ({ saved: v.studentId })),
  removeResult: jest.fn(async () => ({ deleted: 1 })),
}));
jest.mock("../services/attendance.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/attendance.js"),
  getAttendance: jest.fn(async () => [{ studentId: 20, status: "Present" }]),
  markClassAttendance: jest.fn(async () => ({ saved: 1 })),
}));
jest.mock("../services/notify.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/notify.js"),
  notifyAbsences: jest.fn(async () => undefined),
}));
jest.mock("../services/test.js", () => ({
  __esModule: true,
  ...jest.requireActual("../services/test.js"),
  getParentContact: jest.fn(async () => null),
}));

const app = require("../index.js").default;
const { Class, Student, Teacher } = require("../models/index.js");
const results = require("../services/results.js");
const attendance = require("../services/attendance.js");
const { assertClassAccess, assertClassWrite, getTeacherClassName } = attendance;

const store = require("../services/accessStore.js"); // the in-memory fake (testSupport/jestSetup.js)
const { clearAccessCache } = require("../services/officeAccess.js");
const { officeUser } = require("../testSupport/officeUser.js");

// The school's own Head Teacher role, as an Administrator would make it.
const HEAD_TEACHER_PERMISSIONS = [
  "overview.dashboard", "academics.all_classes", "students.view", "students.view_files", "staff.view",
  "staff_attendance.view", "staff_attendance.mark", "classes.view", "subjects.view", "subjects.assign_teachers",
  "terms.view", "results.view", "results.enter", "results.delete", "results.notify_ready", "results.remind_teachers",
  "report_cards.view", "grading.view", "grading.manage", "attendance.view", "attendance.mark", "timetable.view",
  "timetable.manage", "promotion.manage", "promotion.view_history", "reports.academic_class", "reports.academic_school",
  "news.view", "news.post", "news.manage",
];
store.addRole({ roleId: 7, name: "Head Teacher", permissions: HEAD_TEACHER_PERMISSIONS });
// A custom role WITHOUT "every class": only results, for the class linked to the login.
store.addRole({ roleId: 8, name: "Form Tutor", permissions: ["results.view", "results.enter"] });

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const headTeacher = sign({ category: "Head Teacher", username: "head", teacherId: 9, roleId: 7 });
const formTutor = sign({ category: "Form Tutor", username: "tutor", teacherId: 3, roleId: 8 });
const admin = sign({ category: "Administrator", username: "admin", teacherId: null });
const classTeacher = sign({ category: "Class Teacher", username: "ct", teacherId: 3 });
const auth = (r, t) => r.set("Authorization", `Bearer ${t}`);

const HT = officeUser("Head Teacher", { username: "head", teacherId: 9 }, HEAD_TEACHER_PERMISSIONS);

beforeEach(() => {
  jest.clearAllMocks();
  clearAccessCache();
  // Teacher 3 is the Class Teacher of JHS 1; the Head Teacher (9) has no class.
  jest.spyOn(Class, "findOne").mockImplementation(async ({ where }) =>
    where?.teacherId === 3 ? { classId: 1, name: "JHS 1" } : null
  );
  // Pupil 10 is in JHS 1 (the Class Teacher's own class).
  jest.spyOn(Student, "findAll").mockImplementation(async ({ where }) => {
    const ids = Object.getOwnPropertySymbols(where?.studentId || {}).flatMap((s) => where.studentId[s]);
    return ids.filter((id) => id === 10).map((studentId) => ({ studentId }));
  });
});
afterAll(() => jest.restoreAllMocks());

describe("class-scoping helpers", () => {
  it("academics.all_classes: never class-scoped", async () => {
    await expect(getTeacherClassName(HT)).resolves.toBeNull();
    await expect(assertClassAccess(HT, "JHS 2")).resolves.toBeUndefined();
    expect(Class.findOne).not.toHaveBeenCalled();
  });

  it("academics.all_classes without edit_closed_terms: pupils of any class, in the open term", async () => {
    await expect(assertClassWrite(HT, "JHS 2", [20, 21], 5)).resolves.toBeUndefined();
    expect(Student.findAll).not.toHaveBeenCalled();
  });

  it("without academics.edit_closed_terms a closed term is refused; the Administrator holds it", async () => {
    await expect(assertClassWrite(HT, "JHS 2", [20], 4)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("only change the open term"),
    });
    await expect(assertClassWrite(officeUser("Administrator"), "JHS 2", [20], 4)).resolves.toBeUndefined();
  });

  it("edit_closed_terms without all_classes: a closed term of the own class only", async () => {
    const u = officeUser("Archivist", { teacherId: 3 }, ["academics.edit_closed_terms"]);
    await expect(assertClassWrite(u, "JHS 1", [10], 4)).resolves.toBeUndefined();
    await expect(assertClassWrite(u, "JHS 2", [20], 4)).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertClassWrite(u, "JHS 1", [20], 4)).rejects.toMatchObject({ statusCode: 403 }); // pupil 20 isn't in JHS 1
  });

  it("a Class Teacher (no all_classes) is still limited to their own class", async () => {
    const ct = officeUser("Class Teacher", { teacherId: 3 });
    await expect(assertClassAccess(ct, "JHS 2")).rejects.toMatchObject({ statusCode: 403 });
    await expect(assertClassAccess(ct, "JHS 1")).resolves.toBeUndefined();
  });

  it("a user whose permissions were never loaded is scoped (fail closed), even with category Administrator", async () => {
    await expect(assertClassAccess({ category: "Administrator", teacherId: 3 }, "JHS 2")).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("routes: a custom role with academics.all_classes works on a class that isn't its own", () => {
  it("reads a class's results", async () => {
    const res = await auth(request(app).get("/student-results?class=JHS%202&term=5"), headTeacher);
    expect(res.status).toBe(200);
    expect(results.getClassResult).toHaveBeenCalled();
  });

  it("writes a subject result and deletes a result", async () => {
    const body = { class: "JHS 2", studentId: 20, subjectId: 4, termId: 5, classScore: 30, examScore: 50 };
    const res = await auth(request(app).post("/upsert-single-subject-result"), headTeacher).send(body);
    expect(res.status).toBe(200);
    expect(results.upsertMarksResult).toHaveBeenCalledWith(expect.objectContaining({ studentId: 20, enteredBy: "head" }));
    const del = await auth(request(app).delete("/delete-result?student_id=20&class=JHS%202&termId=5"), headTeacher);
    expect(del.status).toBe(200);
    expect(results.removeResult).toHaveBeenCalledWith(expect.objectContaining({ class: "JHS 2" }));
  });

  it("a closed term's result is refused", async () => {
    const res = await auth(request(app).post("/upsert-single-subject-result"), headTeacher).send({ class: "JHS 2", studentId: 20, subjectId: 4, termId: 4 });
    expect(res.status).toBe(403);
    expect(results.upsertMarksResult).not.toHaveBeenCalled();
  });

  it("reads and marks attendance", async () => {
    const read = await auth(request(app).get("/student-attendance?class=JHS%202&date=2026-11-17"), headTeacher);
    expect(read.status).toBe(200);
    const mark = await auth(request(app).post("/mark-attendance"), headTeacher).send({
      class: "JHS 2",
      dateMarked: "2026-11-17",
      studentAttendance: [{ studentId: 20, status: "Present" }],
    });
    expect(mark.status).toBe(200);
    expect(attendance.markClassAttendance).toHaveBeenCalledWith(expect.objectContaining({ className: "JHS 2" }));
  });

  it("a custom role WITHOUT all_classes is limited to its own class", async () => {
    expect((await auth(request(app).get("/student-results?class=JHS%202&term=5"), formTutor)).status).toBe(403);
    expect((await auth(request(app).get("/student-results?class=JHS%201&term=5"), formTutor)).status).toBe(200);
    // and reaches nothing outside its permissions
    expect((await auth(request(app).get("/student-attendance?class=JHS%201&date=2026-11-17"), formTutor)).status).toBe(403);
    expect((await auth(request(app).delete("/delete-result?student_id=10&class=JHS%201&termId=5"), formTutor)).status).toBe(403);
  });

  it("the same requests from another class's Class Teacher are refused", async () => {
    expect((await auth(request(app).get("/student-results?class=JHS%202&term=5"), classTeacher)).status).toBe(403);
    const mark = await auth(request(app).post("/mark-attendance"), classTeacher).send({
      class: "JHS 2",
      dateMarked: "2026-11-17",
      studentAttendance: [{ studentId: 20, status: "Present" }],
    });
    expect(mark.status).toBe(403);
    expect(attendance.markClassAttendance).not.toHaveBeenCalled();
  });
});

describe("news: news.manage manages the feed; news.post only own posts", () => {
  const posts = jest.requireActual("../services/posts.js");
  const ht = { type: "OFFICE", ...HT };
  const ct = { type: "OFFICE", ...officeUser("Class Teacher", { username: "ct" }) };
  it("news.manage sees drafts, manages anyone's post and moderates comments", () => {
    const draft = { status: "DRAFT", audience: "ALL", createdBy: "admin" };
    expect(posts.isNewsManager(ht)).toBe(true);
    expect(posts.canSee(draft, ht)).toBe(true);
    expect(posts.canManage(draft, ht)).toBe(true);
    expect(posts.canSee(draft, ct)).toBe(false);
    expect(posts.canManage(draft, ct)).toBe(false);
    expect(posts.isNewsManager({ type: "OFFICE", ...officeUser("Accountant") })).toBe(false);
    // a portal viewer never manages, whatever it claims
    expect(posts.isNewsManager({ type: "STAFF", category: "Administrator", permissions: new Set(["news.manage"]) })).toBe(false);
  });

  it("news.post: own class only without all_classes, any audience with it", () => {
    expect(posts.postsToOwnClassOnly(ct)).toBe(true);
    const poster = { type: "OFFICE", ...officeUser("Publicist", { username: "pub" }, ["news.post", "academics.all_classes"]) };
    expect(posts.isPoster(poster)).toBe(true);
    expect(posts.postsToOwnClassOnly(poster)).toBe(false);
    expect(posts.canManage({ createdBy: "someone" }, poster)).toBe(false);
    expect(posts.canManage({ createdBy: "pub" }, poster)).toBe(true);
  });
});

// ---------------------------------------------------------------- review fixes
describe("B10 review: closed terms and past registers (without academics.edit_closed_terms)", () => {
  const ownCt = classTeacher; // Class Teacher of JHS 1, pupil 10
  const delResult = (t, termId) =>
    auth(request(app).delete(`/delete-result?student_id=10&class=JHS%201${termId ? `&termId=${termId}` : ""}`), t);
  const mark = (t, day) =>
    auth(request(app).post("/mark-attendance"), t).send({ class: "JHS 1", dateMarked: day, studentAttendance: [{ studentId: 10, status: "Present" }] });
  const clear = (t, day) => auth(request(app).post("/delete-attendance"), t).send({ class: "JHS 1", dateMarked: day });

  beforeEach(() => {
    jest.spyOn(attendance, "removeAttendance").mockResolvedValue(1);
  });

  it("deleting a closed term's result: Head Teacher and Class Teacher refused, Administrator allowed", async () => {
    expect((await delResult(headTeacher, 4)).status).toBe(403);
    expect((await delResult(ownCt, 4)).status).toBe(403);
    expect(results.removeResult).not.toHaveBeenCalled();
    expect((await delResult(admin, 4)).status).toBe(200);
    expect(results.removeResult).toHaveBeenCalledWith(expect.objectContaining({ termId: "4" }));
  });

  it("deleting an open-term result works; no termId means the open term", async () => {
    expect((await delResult(headTeacher, 5)).status).toBe(200);
    expect((await delResult(ownCt)).status).toBe(200);
    expect(results.removeResult).toHaveBeenLastCalledWith(expect.objectContaining({ termId: 5 }));
  });

  it("marking a register outside the open term: refused for both, allowed for the Administrator", async () => {
    expect((await mark(headTeacher, "2026-05-04")).status).toBe(403);
    expect((await mark(ownCt, "2026-12-21")).status).toBe(403);
    expect(attendance.markClassAttendance).not.toHaveBeenCalled();
    expect((await mark(ownCt, "2026-11-17")).status).toBe(200);
    expect((await mark(admin, "2026-05-04")).status).toBe(200);
  });

  it("clearing a register outside the open term: refused for both, allowed for the Administrator", async () => {
    expect((await clear(headTeacher, "2026-05-04")).status).toBe(403);
    expect((await clear(ownCt, "2026-05-04")).status).toBe(403);
    expect((await clear(ownCt, "2026-11-17")).status).toBe(200);
    expect((await clear(admin, "2026-05-04")).status).toBe(200);
  });

  it("no open term: non-Administrators can't change registers", async () => {
    const { getTerm } = require("../services/term.js");
    getTerm.mockResolvedValue(null);
    try {
      expect((await mark(headTeacher, "2026-11-17")).status).toBe(403);
      expect((await clear(ownCt, "2026-11-17")).status).toBe(403);
    } finally {
      getTerm.mockResolvedValue({ termId: 5, startDate: "2026-09-08", endDate: "2026-12-18" });
    }
  });
});

describe("staff.view_sensitive: the staff list's payroll and bank data", () => {
  const PAYROLL = ["ssnitNumber", "tinNumber", "bank", "accountNumber", "salaryId"];
  let seen;
  beforeEach(() => {
    seen = [];
    jest.spyOn(Teacher, "findAll").mockImplementation(async (opts) => {
      seen.push(opts);
      return [];
    });
  });

  it("staff.view without view_sensitive (the custom Head Teacher): columns and the Salary row left out", async () => {
    expect((await auth(request(app).get("/staff"), headTeacher)).status).toBe(200);
    const opts = seen[0];
    expect(opts.attributes.exclude).toEqual(expect.arrayContaining([...PAYROLL, "password"]));
    expect(opts.include.map((i) => i.as)).toEqual(["class_"]);
  });

  it("Administrator (holds view_sensitive): payroll columns and the Salary row included", async () => {
    expect((await auth(request(app).get("/staff"), admin)).status).toBe(200);
    const opts = seen[0];
    for (const f of PAYROLL) expect(opts.attributes.exclude).not.toContain(f);
    expect(opts.include.map((i) => i.as)).toEqual(["class_", "salary"]);
  });
});
