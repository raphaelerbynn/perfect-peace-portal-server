// Portal Attendance page: the pupil's own register (parents use the pupil's
// STU/ login), terms for the picker, and the lockout at GH¢ 100 or more.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";
import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  return {
    __esModule: true,
    ...actual,
    Term: { findAll: jest.fn(), findOne: jest.fn() },
    AcademicYear: { findAll: jest.fn() },
    Attendance: { findAll: jest.fn() },
    FeeCheck: { findAll: jest.fn() },
    Student: { ...actual.Student, findOne: jest.fn() },
  };
});
jest.mock("../controllers/onlyStudentsController.js", () => {
  const ok = (name) => (req, res) => res.json({ handler: name });
  return { __esModule: true, fetchResults: ok("r"), fetchResultDetails: ok("d"), fetchNurseryResults: ok("n"), fetchFeeCheck: ok("f"), fetchLastPaid: ok("l") };
});

const app = require("../index.js").default;
const { Term, AcademicYear, Attendance, FeeCheck, Student } = require("../models/index.js");
const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const pupil = sign({ id: 10, userRole: "STU" });
const teacher = sign({ id: 10, userRole: "STAFF" });
const admin = sign({ category: "Administrator", username: "a", teacherId: null });
const get = (path, t) => request(app).get(path).set("Authorization", `Bearer ${t}`);

const T1 = { termId: 1, term: "2", active: false, startDate: "2026-01-06", endDate: "2026-04-02" };
const T2 = { termId: 2, term: "1", active: true, startDate: "2026-09-08", endDate: "2026-12-17", academicYearId: 7 };

beforeEach(() => {
  jest.clearAllMocks();
  Term.findAll.mockResolvedValue([T1, { termId: 3, term: null, startDate: null, active: false }, T2]);
  Term.findOne.mockImplementation(async ({ where }) => (where.active ? T2 : [T1, T2].find((t) => t.termId === where.termId) ?? null));
  AcademicYear.findAll.mockImplementation(async ({ where }) =>
    [{ academicYearId: 7, name: "2026/2027" }].filter((y) => where.academicYearId.includes(y.academicYearId))
  );
  Attendance.findAll.mockResolvedValue([
    { dateMarked: "2026-11-12", status: "Sick      " },
    { dateMarked: "2026-11-11", status: "Absent    " },
    { dateMarked: "2026-11-10", status: "Present   " },
  ]);
});

it("a pupil reads their own register for the open term (padded values trimmed)", async () => {
  const res = await get("/portal/attendance", pupil);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ term: { termId: 2 }, present: 1, absent: 1, sick: 1, other: 0, total: 3 });
  expect(res.body.days[0]).toEqual({ date: "2026-11-12", status: "Sick" });
  expect(Attendance.findAll.mock.calls[0][0].where).toEqual({ studentId: 10, termId: 2 });
});
it("a chosen term; a bad or unknown term is refused", async () => {
  await get("/portal/attendance?termId=1", pupil);
  expect(Attendance.findAll.mock.calls[0][0].where.termId).toBe(1);
  expect((await get("/portal/attendance?termId=x", pupil)).status).toBe(400);
  expect((await get("/portal/attendance?termId=99", pupil)).status).toBe(404);
});
it("no open term → empty", async () => {
  Term.findOne.mockResolvedValue(null);
  expect((await get("/portal/attendance", pupil)).body).toMatchObject({ term: null, total: 0, days: [] });
});
it("teachers can't read a pupil register here; office tokens fall through", async () => {
  expect((await get("/portal/attendance", teacher)).status).toBe(403);
  expect((await get("/portal/attendance", admin)).status).toBe(404);
});
it("terms newest first, undated last", async () => {
  expect((await get("/portal/terms", pupil)).body.map((t) => t.termId)).toEqual([2, 1, 3]);
});
it("B7: terms and the register carry the academic year's name (null for old terms with none)", async () => {
  const terms = (await get("/portal/terms", pupil)).body;
  expect(terms.map((t) => t.academicYear)).toEqual(["2026/2027", null, null]);
  expect((await get("/portal/attendance", pupil)).body.term).toMatchObject({ termId: 2, academicYear: "2026/2027" });
  expect((await get("/portal/attendance?termId=1", pupil)).body.term.academicYear).toBeNull();
});
it("results are locked at exactly GH¢ 100 owing (fee check on)", async () => {
  FeeCheck.findAll.mockResolvedValue([{ value: "true" }]);
  Student.findOne.mockResolvedValue({ feesOwing: "100.00" });
  expect((await get("/result", pupil)).status).toBe(403);
  Student.findOne.mockResolvedValue({ feesOwing: "99.99" });
  expect((await get("/result", pupil)).status).toBe(200);
});
