// AI-1: the Ask tool catalogue. One test per tool on its query shape and what
// it returns, plus who may use which tool (offered AND refused at call time).
// No DB: sequelize.query is mocked and answers by SQL pattern; the services a
// tool wraps are mocked.
const mockQ = { calls: [], handlers: [] };
jest.mock("../config/database.js", () => {
  const actual = jest.requireActual("../config/database.js");
  actual.default.query = jest.fn(async (sql, opts) => {
    mockQ.calls.push({ sql, replacements: opts?.replacements });
    const h = mockQ.handlers.find(([re]) => re.test(sql));
    return h ? h[1](opts?.replacements || {}) : [];
  });
  return actual;
});
jest.mock("../services/dashboard.js", () => ({ __esModule: true, getDashboardSummary: jest.fn() }));
jest.mock("../services/academicReports.js", () => ({ __esModule: true, getTermReport: jest.fn() }));
jest.mock("../services/graph.js", () => ({ __esModule: true, getProfitLoss: jest.fn() }));
jest.mock("../services/staffAttendance.js", () => ({ __esModule: true, getStaffSummary: jest.fn() }));

import { getDashboardSummary } from "../services/dashboard.js";
import { getTermReport } from "../services/academicReports.js";
import { getProfitLoss } from "../services/graph.js";
import { getStaffSummary } from "../services/staffAttendance.js";
import { invokeTool, resolveTerm, termRange, toolsFor, TOOL_NAMES, TOOLS, ToolRefusedError, declarationsFor } from "../services/ai/ask/tools.js";

import { officeUser } from "../testSupport/officeUser.js";
import { PERMISSION_KEYS } from "../utils/permissions.js";

// B10: callers as the authenticator leaves them (the system roles' permissions).
const admin = officeUser("Administrator", { username: "head" });
const accountant = officeUser("Accountant", { username: "bursar" });
const custom = (perms) => officeUser("Custom", { username: "custom", roleId: 20 }, perms);
const TERM = { termId: 12, term: "1", startDate: "2026-09-08", endDate: "2026-12-18", active: true, academicYearId: 3, yearName: "2026/2027" };
const PREV = { termId: 11, term: "3", startDate: "2026-04-27", endDate: "2026-07-24", active: false, academicYearId: 2, yearName: "2025/2026" };

const on = (re, fn) => mockQ.handlers.push([re, fn]);
const sqlLike = (re) => mockQ.calls.filter((c) => re.test(c.sql));
const run = (name, args = {}, user = admin) => invokeTool(name, args, { user });

beforeEach(() => {
  mockQ.calls = [];
  mockQ.handlers = [];
  jest.clearAllMocks();
  // The open term (ONE_TERM_SQL) and the term list (TERMS_SQL).
  on(/t\.active = TRUE\) OR t\.term_id/, ({ termId }) => (termId == null || termId === 12 ? [TERM] : termId === 11 ? [PREV] : []));
  on(/FROM "dbo"\."Term" t\s+LEFT JOIN "dbo"\."Academic_year" y[\s\S]*ORDER BY t\.start_date DESC NULLS LAST, t\.term_id DESC\s+LIMIT :limit/, () => [TERM, PREV]);
  on(/FROM "dbo"\."Class" WHERE class_id = :classId/, ({ classId }) => (classId === 5 ? [{ classId: 5, name: " Basic  4 ", isAlumni: false }] : []));
});

describe("roles: what each office role is offered and may call", () => {
  const FINANCE = ["current_term", "students_count", "students_count_by_class", "fees_students_owing", "fees_collection_by_term", "fees_collection_by_class", "income_expense_summary"];

  it("the catalogue: 15 read-only tools, each with a JSON schema and the permissions it needs", () => {
    expect(TOOLS).toHaveLength(15);
    expect(new Set(TOOL_NAMES).size).toBe(15);
    for (const t of TOOLS) {
      expect(t.parameters).toMatchObject({ type: "object", properties: expect.any(Object) });
      expect(t.description.length).toBeGreaterThan(20);
      expect(Array.isArray(t.needs)).toBe(true);
      for (const group of t.needs) {
        expect(group.length).toBeGreaterThan(0);
        for (const k of group) expect(PERMISSION_KEYS).toContain(k);
      }
    }
  });

  it("the Administrator is offered every tool", () => {
    expect(toolsFor(admin).map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it("the Accountant is offered the finance tools only (no results, no attendance, no staff)", () => {
    expect(toolsFor(accountant).map((t) => t.name).sort()).toEqual([...FINANCE].sort());
    const offered = declarationsFor(accountant).map((d) => d.name).join(" ");
    expect(offered).not.toMatch(/results_|attendance_|staff_/);
    // what the model sees carries no roles or handlers
    expect(Object.keys(declarationsFor(accountant)[0]).sort()).toEqual(["description", "name", "parameters"]);
  });

  it("Class Teachers and portal tokens are offered nothing", () => {
    expect(toolsFor(officeUser("Class Teacher", { username: "ct" }))).toEqual([]);
    expect(toolsFor({ id: 3, userRole: "STAFF" })).toEqual([]);
    expect(toolsFor(null)).toEqual([]);
  });

  it("a role name or a token's claims are never read: only the permissions loaded on the server", () => {
    expect(toolsFor({ category: "Administrator", username: "head" })).toEqual([]); // no permissions loaded
    expect(toolsFor({ category: "Administrator", username: "head", permissions: [...PERMISSION_KEYS] })).toEqual([]); // a list from a token, not the server's Set
  });

  describe("custom roles (B10): the tools follow the role's other permissions", () => {
    it("ai.ask + fees.view: the fee tools, pupil counts and the current term; no income/expense, results, attendance or staff", () => {
      const clerk = custom(["ai.ask", "fees.view"]);
      expect(toolsFor(clerk).map((t) => t.name).sort()).toEqual(
        ["current_term", "students_count", "students_count_by_class", "fees_students_owing", "fees_collection_by_term", "fees_collection_by_class"].sort()
      );
      expect(toolsFor(clerk).every((t) => FINANCE.includes(t.name))).toBe(true);
    });

    it.each(["income_expense_summary", "results_top_students", "attendance_rate_by_class", "staff_count", "staff_attendance_summary"])(
      "ai.ask + fees.view is refused %s at call time, before any query runs",
      async (name) => {
        await expect(run(name, {}, custom(["ai.ask", "fees.view"]))).rejects.toBeInstanceOf(ToolRefusedError);
        expect(mockQ.calls).toHaveLength(0);
        expect(getProfitLoss).not.toHaveBeenCalled();
        expect(getTermReport).not.toHaveBeenCalled();
      }
    );

    it("ai.ask + accounting.view: income and expense, counts and the current term", () => {
      expect(toolsFor(custom(["ai.ask", "accounting.view"])).map((t) => t.name).sort()).toEqual(
        ["current_term", "students_count", "students_count_by_class", "income_expense_summary"].sort()
      );
    });

    it("fees.view without ai.ask: nothing", () => {
      expect(toolsFor(custom(["fees.view", "accounting.view", "results.view", "academics.all_classes"]))).toEqual([]);
    });

    it("whole-school registers and results need academics.all_classes as well", () => {
      const ownClass = custom(["ai.ask", "attendance.view", "results.view"]);
      expect(toolsFor(ownClass).map((t) => t.name)).toEqual(["current_term"]);
      const everyClass = custom(["ai.ask", "attendance.view", "results.view", "academics.all_classes"]);
      expect(toolsFor(everyClass).map((t) => t.name).sort()).toEqual(
        ["current_term", "students_count", "students_count_by_class", "attendance_rate_by_class", "attendance_chronic_absentees", "results_subject_averages", "results_top_students", "results_bottom_students"].sort()
      );
    });

    it("staff tools: staff.view for the list and count, staff_attendance.view for the register summary", () => {
      expect(toolsFor(custom(["ai.ask", "staff.view"])).map((t) => t.name).sort()).toEqual(["current_term", "staff_count", "staff_list"]);
      expect(toolsFor(custom(["ai.ask", "staff_attendance.view"])).map((t) => t.name).sort()).toEqual(["current_term", "staff_attendance_summary"]);
    });
  });

  it.each(["results_top_students", "results_bottom_students", "results_subject_averages", "attendance_rate_by_class", "attendance_chronic_absentees", "staff_list", "staff_count", "staff_attendance_summary"])(
    "the Accountant is refused %s at call time, before any query runs",
    async (name) => {
      await expect(run(name, {}, accountant)).rejects.toBeInstanceOf(ToolRefusedError);
      await expect(run(name, {}, accountant)).rejects.toThrow("not something you can look up");
      expect(mockQ.calls).toHaveLength(0);
      expect(getTermReport).not.toHaveBeenCalled();
      expect(getStaffSummary).not.toHaveBeenCalled();
    }
  );

  it("an unknown tool is refused", async () => {
    await expect(run("drop_tables")).rejects.toThrow("There is no tool called drop_tables");
  });
});

describe("terms", () => {
  it("resolveTerm: the open term by default, a given id, an unknown id, and the latest when none is open", async () => {
    expect((await resolveTerm({})).term.termId).toBe(12);
    expect((await resolveTerm({ termId: 11 })).term.termId).toBe(11);
    await expect(resolveTerm({ termId: 99 })).rejects.toThrow("no term with id 99");
    await expect(resolveTerm({ termId: "abc" })).rejects.toThrow("whole number");
    mockQ.handlers[0] = [/t\.active = TRUE\) OR t\.term_id/, () => []];
    const r = await resolveTerm({});
    expect(r.term.termId).toBe(12);
    expect(r.note).toMatch(/No term is open/);
  });

  it("termRange: from the day after the previous term ended to the end (or today)", () => {
    expect(termRange(TERM, [TERM, PREV], "2027-01-10")).toEqual({ from: "2026-07-25", to: "2026-12-18" });
    expect(termRange(TERM, [TERM, PREV], "2026-10-01")).toEqual({ from: "2026-07-25", to: "2026-10-01" });
    expect(termRange(PREV, [PREV], "2027-01-10")).toEqual({ from: "2026-04-27", to: "2026-07-24" });
  });
});

describe("one test per tool: query shape and result", () => {
  it("current_term", async () => {
    const r = await run("current_term");
    expect(r.currentTerm).toEqual({ termId: 12, name: "Term 1 2026/2027", startDate: "2026-09-08", endDate: "2026-12-18", current: true });
    expect(r.recentTerms).toHaveLength(2);
    const [q] = sqlLike(/FROM "dbo"\."Term" t/);
    expect(q.replacements).toEqual({ limit: 9 });
  });

  it("students_count wraps the dashboard counts (graduated / left classes not on the roll)", async () => {
    getDashboardSummary.mockResolvedValue({ totalStudents: 420, activeStudents: 400, students: 400, boys: 210, girls: 190, totalStaff: 30, totalClasses: 14 });
    expect(await run("students_count", {}, accountant)).toEqual({ pupilsOnRoll: 400, boys: 210, girls: 190, includingGraduatedOrLeft: 420, classes: 14 }); // no staff figure: the Accountant has no staff tools
    expect(getDashboardSummary).toHaveBeenCalledWith();
  });

  it("students_count_by_class: one GROUP BY over live classes, pupils not archived; graduated classes apart", async () => {
    on(/GROUP BY c\.class_id/, () => [
      { classId: 1, name: "Basic 1", isAlumni: false, pupils: 30, boys: 14, girls: 16 },
      { classId: 9, name: "Graduated", isAlumni: true, pupils: 50, boys: 25, girls: 25 },
    ]);
    on(/class_id IS NULL/, () => [{ pupils: 2 }]);
    const r = await run("students_count_by_class");
    expect(r).toEqual({
      totalOnRoll: 32,
      classes: [{ classId: 1, name: "Basic 1", pupils: 30, boys: 14, girls: 16 }],
      pupilsWithNoClass: 2,
      graduatedOrLeftClasses: [{ classId: 9, name: "Graduated", pupils: 50, boys: 25, girls: 25 }],
    });
    const [q] = sqlLike(/GROUP BY c\.class_id/);
    expect(q.sql).toMatch(/s\.is_deleted IS NOT TRUE/);
    expect(q.sql).toMatch(/c\.is_deleted IS NOT TRUE/);
  });

  it("fees_students_owing: owing > 0 and >= the minimum, most first, capped, with the full count and total", async () => {
    on(/s\.fees_owing >= :minAmount/, () => [
      { studentId: 1, fName: "Ama", lName: "Mensah", className: "Basic 4", owing: "850.00", count: 73, totalOwing: "21500.5" },
      { studentId: 2, fName: "Kofi", lName: null, className: null, owing: 600, count: 73, totalOwing: 21500.5 },
    ]);
    const r = await run("fees_students_owing", { minAmount: 500, classId: 5, limit: 500 }, accountant);
    expect(r).toEqual({
      class: "Basic  4",
      minAmount: 500,
      pupilsOwing: 73,
      totalOwing: 21500.5,
      shown: 2,
      pupils: [
        { name: "Ama Mensah", class: "Basic 4", owing: 850 },
        { name: "Kofi", class: "No class", owing: 600 },
      ],
    });
    const [q] = sqlLike(/s\.fees_owing >= :minAmount/);
    expect(q.replacements).toEqual({ minAmount: 500, classId: 5, limit: 50 });
    expect(q.sql).toMatch(/ORDER BY s\.fees_owing DESC/);
    expect(q.sql).toMatch(/s\.fees_owing > 0/);
    await run("fees_students_owing", {}, accountant);
    expect(sqlLike(/s\.fees_owing >= :minAmount/)[1].replacements).toEqual({ minAmount: 1, classId: null, limit: 20 });
    await expect(run("fees_students_owing", { classId: 77 })).rejects.toThrow("no class with id 77");
  });

  it("fees_collection_by_term: reversed payments left out, newest term first, payments with no term apart", async () => {
    on(/COUNT\(DISTINCT f\.student_id\)::int AS "pupilsPaid"\s+FROM "dbo"\."Term" t/, () => [{ ...TERM, collected: "52000", payments: 300, pupilsPaid: 280 }]);
    on(/f\.term_id IS NULL/, () => [{ collected: 1200, payments: 4 }]);
    const r = await run("fees_collection_by_term", {}, accountant);
    expect(r.terms).toEqual([{ termId: 12, name: "Term 1 2026/2027", startDate: "2026-09-08", endDate: "2026-12-18", current: true, collected: 52000, payments: 300, pupilsPaid: 280 }]);
    expect(r.paymentsWithNoTerm).toEqual({ collected: 1200, payments: 4 });
    const [q] = sqlLike(/FROM "dbo"\."Term" t\s+LEFT JOIN "dbo"\."Fee" f/);
    expect(q.sql).toMatch(/f\.reversed_at IS NULL/);
    expect(q.replacements).toEqual({ termId: null, limit: 6 });
  });

  it("fees_collection_by_class: one term, by the payment's class, with what each class owes now", async () => {
    on(/WHERE f\.reversed_at IS NULL AND f\.term_id = :termId/, () => [
      { classId: 5, className: "Basic 4", collected: 9000, payments: 40, pupilsPaid: 30 },
      { classId: null, className: null, collected: 100, payments: 1, pupilsPaid: 1 },
    ]);
    on(/GROUP BY s\.class_id/, () => [{ classId: 5, owingNow: "3000.50", pupilsOwing: 7 }]);
    const r = await run("fees_collection_by_class", {}, accountant);
    expect(r.term.termId).toBe(12);
    expect(r.totalCollected).toBe(9100);
    expect(r.classes).toEqual([
      { class: "Basic 4", collected: 9000, payments: 40, pupilsPaid: 30, owingNow: 3000.5, pupilsOwingNow: 7 },
      { class: "No class recorded", collected: 100, payments: 1, pupilsPaid: 1, owingNow: 0, pupilsOwingNow: 0 },
    ]);
    expect(sqlLike(/f\.term_id = :termId/)[0].replacements).toEqual({ termId: 12 });
  });

  it("income_expense_summary wraps the P/L with the term's A2 range", async () => {
    getProfitLoss.mockResolvedValue({ incomeTotal: 2000, feesTotal: 50000, expenseTotal: 30000, profit: 22000 });
    const r = await run("income_expense_summary", { termId: 12 }, accountant);
    expect(getProfitLoss).toHaveBeenCalledWith({ startDate: "2026-07-25", endDate: expect.stringMatching(/^2026-\d\d-\d\d$/) });
    expect(r).toMatchObject({ from: "2026-07-25", feesCollected: 50000, otherIncome: 2000, expenses: 30000, balance: 22000 });
  });

  it("attendance_rate_by_class wraps the B11 term report (classes with no register left out)", async () => {
    getTermReport.mockResolvedValue({
      totals: { attendanceRate: 91.2, daysMarked: 4000 },
      classes: [
        { classId: 5, name: "Basic 4", attendanceRate: 88.5, daysMarked: 1200 },
        { classId: 6, name: "Basic 5", attendanceRate: null, daysMarked: 0 },
      ],
    });
    const r = await run("attendance_rate_by_class", { termId: 11 });
    expect(getTermReport).toHaveBeenCalledWith(11);
    expect(r).toMatchObject({ schoolRate: 91.2, daysMarked: 4000, classes: [{ classId: 5, class: "Basic 4", rate: 88.5, daysMarked: 1200 }] });
  });

  it("attendance_chronic_absentees: roll-up or register per pupil, Present only, below the rate, at least 5 days", async () => {
    on(/WITH tot AS/, () => [{ studentId: 3, fName: "Yaw", lName: "Boateng", className: "Basic 4", present: 20, days: 40, rate: 50, count: 9 }]);
    const r = await run("attendance_chronic_absentees", { belowRate: 75, classId: 5 });
    expect(r).toMatchObject({ belowRate: 75, class: "Basic  4", total: 9, shown: 1, rows: [{ name: "Yaw Boateng", class: "Basic 4", present: 20, daysMarked: 40, rate: 50 }] });
    const [q] = sqlLike(/WITH tot AS/);
    expect(q.sql).toMatch(/"dbo"\."Total_attendance"/);
    expect(q.sql).toMatch(/TRIM\(status\) = 'Present'/);
    expect(q.replacements).toEqual({ termId: 12, classId: 5, below: 75, minDays: 5, limit: 20 });
  });

  it("results_subject_averages: the school's subjects, or one class's from the same report", async () => {
    getTermReport.mockResolvedValue({
      totals: { averageScore: 61.2, passRate: 80 },
      subjects: [{ name: "English", average: 58.1, passRate: 75, marks: 300, classes: 9 }],
      classes: [{ classId: 5, classKey: "basic 4", averageScore: 64, passRate: 85, subjects: [{ name: "Maths", average: 70, passRate: 90, marks: 30 }] }],
    });
    expect(await run("results_subject_averages")).toMatchObject({ class: "whole school", averageScore: 61.2, subjects: [{ subject: "English", average: 58.1, passRate: 75, marks: 300, classes: 9 }] });
    expect(await run("results_subject_averages", { classId: 5 })).toMatchObject({ class: "Basic  4", averageScore: 64, subjects: [{ subject: "Maths", average: 70, passRate: 90, marks: 30 }] });
  });

  it.each([
    ["results_top_students", "DESC"],
    ["results_bottom_students", "ASC"],
  ])("%s: newest result per pupil, raw ÷ total × 100, ordered %s, class matched by trimmed name", async (name, dir) => {
    on(/FROM "dbo"\."Student_result"/, () => [{ studentId: 1, fName: "Esi", lName: "Owusu", className: "Basic 4", score: 92.5, count: 31 }]);
    const r = await run(name, { classId: 5, limit: 3 });
    expect(r).toMatchObject({ class: "Basic  4", total: 31, shown: 1, rows: [{ name: "Esi Owusu", class: "Basic 4", score: 92.5 }] });
    const [q] = sqlLike(/FROM "dbo"\."Student_result"/);
    expect(q.sql).toMatch(new RegExp(`ORDER BY r\\.pct ${dir}`));
    expect(q.sql).toMatch(/DISTINCT ON \(student_id\)/);
    expect(q.sql).toMatch(/raw_score \* 100\.0 \/ total_raw_score/);
    expect(q.replacements).toEqual({ termId: 12, classKey: "basic 4", limit: 3 });
  });

  it("staff_list: names, positions and classes only (no contact or bank columns)", async () => {
    on(/FROM "dbo"\."Teacher" t[\s\S]*LIMIT :limit/, () => [{ teacherId: 1, name: "Grace Asante", position: null, classTeacherOf: "Basic 4", count: 31 }]);
    const r = await run("staff_list", { limit: 1000 });
    expect(r).toEqual({ total: 31, shown: 1, rows: [{ name: "Grace Asante", position: "Not recorded", classTeacherOf: "Basic 4" }] });
    const [q] = sqlLike(/FROM "dbo"\."Teacher" t/);
    expect(q.sql).not.toMatch(/phone|email|address|ssnit|tin_number|account_number|password/i);
    expect(q.replacements).toEqual({ limit: 100 });
  });

  it("staff_count: by position, summed", async () => {
    on(/GROUP BY 1/, () => [
      { position: "Teacher", staff: 25, men: 10, women: 15 },
      { position: "No position recorded", staff: 3, men: 1, women: 2 },
    ]);
    expect(await run("staff_count")).toEqual({
      totalStaff: 28,
      byPosition: [
        { position: "Teacher", staff: 25, men: 10, women: 15 },
        { position: "No position recorded", staff: 3, men: 1, women: 2 },
      ],
    });
  });

  it("staff_attendance_summary wraps the B9 summary for the term (staff with no marks left out)", async () => {
    getStaffSummary.mockResolvedValue({
      totals: { staff: 2, counts: { PRESENT: 30, LATE: 5, ABSENT: 3, SICK: 1, ON_LEAVE: 0, PERMISSION: 1 }, marked: 40, percent: 87.5 },
      staff: [
        { name: "Grace Asante", counts: { PRESENT: 18, LATE: 2, ABSENT: 0, SICK: 0, ON_LEAVE: 0, PERMISSION: 0 }, marked: 20, percent: 100 },
        { name: "New Staff", counts: {}, marked: 0, percent: null },
      ],
    });
    const r = await run("staff_attendance_summary");
    expect(getStaffSummary).toHaveBeenCalledWith({ termId: 12 });
    expect(r.school).toEqual({ staff: 2, marked: 40, present: 30, late: 5, absent: 3, sick: 1, onLeave: 0, permission: 1, percent: 87.5 });
    expect(r.staff).toEqual([{ name: "Grace Asante", marked: 20, present: 18, late: 2, absent: 0, sick: 0, onLeave: 0, permission: 0, percent: 100 }]);
  });
});
