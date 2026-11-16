// AI-1: every Ask tool is read only. Runs each tool for real (the services it
// wraps too) against a recorder in place of the database: every statement that
// would reach Postgres, whether raw SQL or built by a Sequelize model, goes
// through sequelize.query, so if one of them writes, this sees it.
// Plus a source check: the tool files contain no write call at all.
import fs from "fs";
import path from "path";

const mockSeen = [];
const mockTerm = { termId: 12, term: "1", startDate: "2026-09-08", endDate: "2026-12-18", active: true, academicYearId: 3, yearName: "2026/2027" };
jest.mock("../config/database.js", () => {
  const actual = jest.requireActual("../config/database.js");
  actual.default.query = jest.fn(async (sql, opts = {}) => {
    const text = typeof sql === "string" ? sql : sql?.query || String(sql);
    mockSeen.push(text);
    if (/"Term"/.test(text) && !/"Student_result"|"Fee"|"Total_attendance"/.test(text)) return opts.plain ? { ...mockTerm } : [{ ...mockTerm }];
    if (/"Class" WHERE class_id/.test(text)) return [{ classId: 5, name: "Basic 4", isAlumni: false }];
    return opts.plain ? null : [];
  });
  return actual;
});

import { invokeTool, TOOLS } from "../services/ai/ask/tools.js";

const WRITE = /^\s*(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|LOCK|CALL|DO)\b|\bFOR\s+UPDATE\b|\bFOR\s+SHARE\b|\bINTO\s+"|\bnextval\(/i;
const READ = /^\s*(SELECT|WITH)\b/i;

const admin = { category: "Administrator", username: "head" };
// The table each tool must actually reach (so a tool that failed early can't pass by sending nothing).
const REACHES = {
  students_count: "Student",
  income_expense_summary: "Expense",
  attendance_rate_by_class: "Total_attendance",
  results_subject_averages: "Student_marks",
  staff_attendance_summary: "Staff_attendance",
  results_top_students: "Student_result",
  fees_collection_by_class: "Fee",
};
const ARGS = [{}, { termId: 12, classId: 5, limit: 5, minAmount: 100, belowRate: 70 }];

describe("Ask tools are read only", () => {
  it.each(TOOLS.map((t) => [t.name]))("%s sends only SELECTs", async (name) => {
    mockSeen.length = 0;
    for (const args of ARGS) {
      // A tool may refuse an argument (that's fine); what matters is what it sent.
      // eslint-disable-next-line no-await-in-loop
      await invokeTool(name, args, { user: admin }).catch(() => null);
    }
    expect(mockSeen.length).toBeGreaterThan(0);
    if (REACHES[name]) expect([name, mockSeen.some((q) => q.includes(`"${REACHES[name]}"`))]).toEqual([name, true]);
    for (const sql of mockSeen) {
      expect([name, sql.trim().slice(0, 60), READ.test(sql)]).toEqual([name, sql.trim().slice(0, 60), true]);
      expect([name, sql.trim().slice(0, 60), WRITE.test(sql)]).toEqual([name, sql.trim().slice(0, 60), false]);
    }
  });

  it("the tool and fast-path sources contain no write call and no SQL write", () => {
    const dir = path.join(__dirname, "../services/ai/ask");
    for (const file of ["tools.js", "fastPath.js"]) {
      const src = fs.readFileSync(path.join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect([file, src.match(/\.(create|bulkCreate|update|upsert|destroy|increment|decrement|save|restore|truncate)\s*\(/)]).toEqual([file, null]);
      expect([file, src.match(/\b(INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|DROP\s|ALTER\s|TRUNCATE\s)/i)]).toEqual([file, null]);
      expect([file, /transaction\s*\(/.test(src)]).toEqual([file, false]);
    }
  });
});
