// B4: whole-class report cards. Pure helpers run for real; the service runs
// against mocked models.
jest.mock("../models/index.js", () => {
  const model = () => ({ findAll: jest.fn(), findOne: jest.fn() });
  return {
    __esModule: true,
    Attendance: model(),
    Class: model(),
    KgAssessment: model(),
    Student: model(),
    StudentMarks: model(),
    StudentResult: model(),
    Subject: model(),
    Term: model(),
    TotalAttendance: model(),
  };
});
jest.mock("../services/attendance.js", () => ({ __esModule: true, assertClassAccess: jest.fn() }));

import {
  Attendance,
  Class,
  KgAssessment,
  Student,
  StudentMarks,
  StudentResult,
  Subject,
  Term,
  TotalAttendance,
} from "../models/index.js";
import { assertClassAccess } from "../services/attendance.js";
import {
  assessCompleteness,
  buildCards,
  competitionRank,
  getClassReportCards,
  getCompleteness,
  ordinal,
} from "../services/reportCards.js";
import { AppError } from "../utils/errorHandling.js";

describe("competitionRank (SchoolPro: 1, 1, 3)", () => {
  const rank = (scores) => {
    const rows = scores.map((score, i) => ({ id: i, score }));
    const m = competitionRank(rows, (r) => r.id, (r) => r.score);
    return rows.map((r) => m.get(r.id) ?? null);
  };
  it("ties share a place and the next place is skipped", () => {
    expect(rank([90, 80, 90, 70])).toEqual([1, 3, 1, 4]);
    expect(rank([50, 50, 50])).toEqual([1, 1, 1]);
  });
  it("accepts numeric strings (Postgres DECIMAL) and skips blanks", () => {
    expect(rank(["75.5", "80", null, "75.5"])).toEqual([2, 1, null, 2]);
    expect(rank([])).toEqual([]);
  });
});

it("ordinal matches the paper card", () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
    "1ST", "2ND", "3RD", "4TH", "11TH", "12TH", "13TH", "21ST", "22ND", "23RD", "101ST", "111TH",
  ]);
  expect(ordinal(null)).toBeNull();
  expect(ordinal(0)).toBeNull();
});

const roster = [
  { studentId: 1, name: "Abena Boateng" },
  { studentId: 2, name: "Kofi Asare" },
  { studentId: 3, name: "Yaw Mensah" },
];
const subjects = [
  { subjectId: 10, name: "English" },
  { subjectId: 11, name: "French" },
  { subjectId: 12, name: "Maths" },
];
const fullResult = (studentId, rawScore) => ({
  studentId,
  rawScore,
  totalRawScore: 200,
  conduct: "Good",
  attitude: "Good",
  interest: "Football",
  teacherRemarks: "Well done",
  promotedTo: null,
});
const mark = (studentId, subjectId, totalScore) => ({
  studentId,
  subjectId,
  totalScore,
  classScorePercentage: totalScore / 2,
  examScorePercentage: totalScore / 2,
  remarks: "Good",
});

describe("assessCompleteness", () => {
  it("complete when every started subject has every pupil and teacher fields are filled", () => {
    const marks = roster.flatMap((p) => [mark(p.studentId, 10, 60), mark(p.studentId, 12, 70)]);
    const out = assessCompleteness({ kg: false, roster, subjects, marks, kgRows: [], results: roster.map((p) => fullResult(p.studentId, 130)) });
    expect(out.complete).toBe(true);
    expect(out.subjects.map((s) => [s.name, s.state])).toEqual([
      ["English", "complete"],
      ["French", "not_started"], // maybe not taught in this class: a warning, not a blocker
      ["Maths", "complete"],
    ]);
  });

  it("lists who is missing a subject, a result, or teacher fields", () => {
    const marks = [mark(1, 10, 60), mark(2, 10, 50), mark(1, 12, 70)];
    const results = [fullResult(1, 130), { ...fullResult(2, 50), conduct: " ", teacherRemarks: null }];
    const out = assessCompleteness({ kg: false, roster, subjects, marks, kgRows: [], results });
    expect(out.complete).toBe(false);
    const english = out.subjects.find((s) => s.name === "English");
    expect(english).toMatchObject({ recorded: 2, expected: 3, state: "incomplete" });
    expect(english.missingStudents.map((s) => s.name)).toEqual(["Yaw Mensah"]);
    expect(out.subjects.find((s) => s.name === "Maths").missingStudents.map((s) => s.studentId)).toEqual([2, 3]);
    expect(out.missingResults).toEqual([{ studentId: 3, name: "Yaw Mensah" }]);
    const kofi = out.students.find((s) => s.studentId === 2);
    expect(kofi).toMatchObject({ hasResult: true, missingSubjects: ["Maths"], missingFields: ["conduct", "class teacher's remarks"] });
  });

  it("nothing entered = not complete", () => {
    const out = assessCompleteness({ kg: false, roster, subjects, marks: [], kgRows: [], results: [] });
    expect(out.complete).toBe(false);
    expect(out.subjects.every((s) => s.state === "not_started")).toBe(true);
  });

  it("KG: complete when every pupil has assessment rows", () => {
    const kgRows = [{ studentId: 1 }, { studentId: 1 }, { studentId: 2 }];
    const out = assessCompleteness({ kg: true, roster, subjects: [], marks: [], results: [], kgRows });
    expect(out).toMatchObject({ kind: "kg", complete: false, missingResults: [{ studentId: 3, name: "Yaw Mensah" }] });
  });
});

describe("buildCards", () => {
  it("class and subject positions use competition ranking; pupils without results still get a card", () => {
    const results = [fullResult(1, 150), fullResult(2, 150)];
    const marks = [mark(1, 10, 80), mark(2, 10, 70), mark(3, 10, 80), mark(1, 12, 70), mark(2, 12, 80)];
    const attendance = new Map([[1, { present: 50, sick: 2, attendance: 55 }]]);
    const cards = buildCards({ kg: false, roster, subjects, results, marks, kgRows: [], attendance });
    expect(cards.map((c) => [c.name, c.position, c.hasResult])).toEqual([
      ["Abena Boateng", 1, true],
      ["Kofi Asare", 1, true],
      ["Yaw Mensah", null, false],
    ]);
    const pos = (c, sid) => c.marks.find((m) => m.subjectId === sid)?.subjectPosition;
    expect(pos(cards[0], 10)).toBe(1);
    expect(pos(cards[2], 10)).toBe(1); // tied with Abena
    expect(pos(cards[1], 10)).toBe(3);
    expect(cards[0]).toMatchObject({ teacherRemarks: "Well done", attendance: { present: 50 }, rawScore: 150 });
    expect(cards[2]).toMatchObject({ rawScore: 80, totalRawScore: 100, attendance: null }); // from marks alone
  });

  it("KG cards carry the assessment rows", () => {
    const kgRows = [{ studentId: 1, assessment: "Counting", category: "Numeracy", promoted: "KG 2" }];
    const cards = buildCards({ kg: true, roster: roster.slice(0, 2), subjects: [], results: [], marks: [], kgRows, attendance: new Map() });
    expect(cards[0]).toMatchObject({ hasResult: true, promotedTo: "KG 2", kg: kgRows });
    expect(cards[1]).toMatchObject({ hasResult: false, kg: [] });
  });
});

describe("service", () => {
  const JHS1 = { classId: 1, name: "JHS 1", section: "JHS" };
  const OPEN = { termId: 5, term: "2", startDate: "2026-09-01", endDate: "2026-12-18", active: true };
  const PAST = { ...OPEN, termId: 4, term: "1", active: false };

  beforeEach(() => {
    jest.resetAllMocks();
    Class.findOne.mockResolvedValue(JHS1);
    Subject.findAll.mockResolvedValue([{ subjectId: 10, name: "English" }]);
    StudentResult.findAll.mockResolvedValue([fullResult(1, 80)]);
    StudentMarks.findAll.mockResolvedValue([mark(1, 10, 80), mark(9, 10, 60)]); // 9 has since left the class
    KgAssessment.findAll.mockResolvedValue([]);
    Student.findAll.mockImplementation(async ({ where }) => {
      const all = [
        { studentId: 1, fName: "Abena", lName: "Boateng" },
        { studentId: 2, fName: "Kofi", lName: "Asare" },
        { studentId: 9, fName: "Esi", lName: "Old" },
      ];
      if (where.studentId) {
        const ids = Object.getOwnPropertySymbols(where.studentId).flatMap((s) => where.studentId[s]);
        return all.filter((s) => ids.includes(s.studentId));
      }
      return all.slice(0, 2); // current members of JHS 1
    });
    TotalAttendance.findAll.mockResolvedValue([]);
    Attendance.findAll.mockResolvedValue([]);
  });

  it("open term: current pupils plus anyone with marks there", async () => {
    Term.findOne.mockResolvedValue(OPEN);
    const out = await getCompleteness({ classId: "1", termId: "5" }, { category: "Administrator" });
    expect(out.roll).toBe(3);
    expect(out.students.map((s) => s.name)).toEqual(["Abena Boateng", "Esi Old", "Kofi Asare"]);
    expect(out.class).toEqual({ classId: 1, name: "JHS 1", section: "JHS", isKg: false });
  });

  it("past term: only pupils with records (today's class has moved on)", async () => {
    Term.findOne.mockResolvedValue(PAST);
    const out = await getCompleteness({ classId: 1, termId: 4 });
    expect(out.students.map((s) => s.studentId)).toEqual([1, 9]);
  });

  it("attendance: closed-term totals, else counted from the daily register", async () => {
    Term.findOne.mockResolvedValue(OPEN);
    TotalAttendance.findAll.mockResolvedValue([{ studentId: 1, present: 40, sick: 1, attendance: 45 }]);
    Attendance.findAll.mockResolvedValue([
      { studentId: 2, status: "Present   " }, // CHAR(10): space-padded
      { studentId: 2, status: "Sick      " },
      { studentId: 2, status: "Absent" },
    ]);
    const out = await getClassReportCards({ classId: 1, termId: 5 });
    const att = Object.fromEntries(out.cards.map((c) => [c.studentId, c.attendance]));
    expect(att[1]).toEqual({ present: 40, sick: 1, attendance: 45 });
    expect(att[2]).toEqual({ present: 1, sick: 1, attendance: 3 });
    expect(Attendance.findAll.mock.calls[0][0].where.termId).toBe(5);
    expect(out.subjects).toEqual([{ subjectId: 10, name: "English" }]);
  });

  it("a Class Teacher login is refused another class", async () => {
    Term.findOne.mockResolvedValue(OPEN);
    assertClassAccess.mockRejectedValue(new AppError("nope", 403));
    await expect(getClassReportCards({ classId: 1, termId: 5 }, { category: "Class Teacher" })).rejects.toMatchObject({
      statusCode: 403,
      message: "You can only see report cards for your own class",
    });
  });

  it.each([
    [{ termId: 5 }, 400],
    [{ classId: 1 }, 400],
  ])("missing ids %o -> %s", async (q, status) => {
    Term.findOne.mockResolvedValue(OPEN);
    await expect(getCompleteness(q)).rejects.toMatchObject({ statusCode: status });
  });

  it("404 for an unknown class or term", async () => {
    Class.findOne.mockResolvedValue(null);
    await expect(getCompleteness({ classId: 7, termId: 5 })).rejects.toMatchObject({ statusCode: 404 });
    Class.findOne.mockResolvedValue(JHS1);
    Term.findOne.mockResolvedValue(null);
    await expect(getCompleteness({ classId: 1, termId: 77 })).rejects.toMatchObject({ statusCode: 404 });
  });
});
