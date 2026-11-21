// AI-4: the watchlist maths, pure (no database): each reason's line and
// figures, edge cases (new pupil, no previous term, KG, closed term), the risk
// level, the order, the fingerprint and the dismissed/handled rule.
import {
  DEFAULT_THRESHOLDS,
  assessPupil,
  attendanceRate,
  daysAwayInARow,
  effectiveStatus,
  fingerprintOf,
  levelFor,
  orderWatchlist,
  passMarkFromBands,
  summariseMarks,
} from "../services/atRisk/signals.js";
import { DEFAULT_JHS_BANDS, DEFAULT_PRIMARY_BANDS } from "../services/grading.js";

const fine = {
  isKg: false,
  openTerm: true,
  owing: 0,
  attendance: { marked: 40, present: 40 },
  recent: [{ date: "2026-11-13", status: "Present" }],
  marks: [
    { subjectName: "English", score: 70 },
    { subjectName: "Mathematics", score: 65 },
    { subjectName: "Science", score: 72 },
  ],
  previous: { subjects: 3, average: 69 },
  previousTermLabel: "Term 1",
  passMark: 50,
};
const kinds = (a) => (a ? a.reasons.map((r) => r.kind) : []);
const figure = (a, kind, label) => a.reasons.find((r) => r.kind === kind).figures.find((f) => f.label === label)?.value;

describe("defaults", () => {
  it("reuse the briefing's lines (90% attendance after 10 days, GH₵ 100 owing)", () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({ attendanceLine: 90, attendanceMinDays: 10, owingThresholdGhs: 100, defaultPassMark: 50 });
  });
  it("a pupil with nothing wrong is not on the list", () => {
    expect(assessPupil(fine)).toBeNull();
  });
});

describe("LOW_ATTENDANCE", () => {
  it("below 90% of marked days present", () => {
    const a = assessPupil({ ...fine, attendance: { marked: 40, present: 33 } });
    expect(kinds(a)).toEqual(["LOW_ATTENDANCE"]);
    expect(figure(a, "LOW_ATTENDANCE", "Attendance this term")).toBe(82.5);
    expect(a.reasons[0].statement).toBe("Present on 33 of 40 marked days this term, 82.5%, below the 90% line.");
    expect(a.riskScore).toBe(15); // 7.5 points under x 2
  });
  it("exactly on the line is fine; too few days marked says nothing (new pupil / start of term)", () => {
    expect(assessPupil({ ...fine, attendance: { marked: 40, present: 36 } })).toBeNull();
    expect(assessPupil({ ...fine, attendance: { marked: 9, present: 2 } })).toBeNull();
    expect(assessPupil({ ...fine, attendance: undefined })).toBeNull();
  });
  it("rate helper: null with nothing marked", () => {
    expect(attendanceRate(0, 0)).toBeNull();
    expect(attendanceRate(2, 3)).toBe(66.7);
  });
});

describe("CONSECUTIVE_ABSENCES", () => {
  const away = (n) => [
    ...Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(13 - i).padStart(2, "0")}`, status: i % 2 ? "Sick      " : "Absent    " })),
    { date: "2026-11-01", status: "Present   " },
  ];
  it("counts padded CHAR statuses, absent and sick, from the latest register back", () => {
    expect(daysAwayInARow(away(4))).toBe(4);
    expect(daysAwayInARow([])).toBe(0);
    const a = assessPupil({ ...fine, recent: away(3) });
    expect(kinds(a)).toEqual(["CONSECUTIVE_ABSENCES"]);
    expect(a.reasons[0].statement).toBe("Away on the last 3 marked days in a row (latest register 2026-11-13).");
    expect(a.firstAction).toMatch(/Call the family today/);
  });
  it("two days is under the line; a closed term doesn't say it", () => {
    expect(assessPupil({ ...fine, recent: away(2) })).toBeNull();
    expect(assessPupil({ ...fine, openTerm: false, recent: away(5) })).toBeNull();
  });
});

describe("SCORE_DROP", () => {
  const down = (avg) => ({ ...fine, marks: fine.marks.map((m) => ({ ...m, score: avg })) });
  it("5+ points down on last term", () => {
    const a = assessPupil(down(60));
    expect(kinds(a)).toEqual(["SCORE_DROP"]);
    expect(figure(a, "SCORE_DROP", "Fall")).toBe(9);
    expect(a.reasons[0].statement).toBe("Average score fell from 69 last term (Term 1) to 60 this term, down 9 points.");
    expect(a.riskScore).toBe(27);
    expect(a.level).toBe("HIGH");
  });
  it("4.9 points is under the line", () => {
    expect(assessPupil({ ...down(64.1) })).toBeNull();
  });
  it("new pupil (no marks last term) or the first term ever: no drop", () => {
    expect(assessPupil({ ...down(40), previous: null, marks: [{ subjectName: "English", score: 60 }, { subjectName: "Maths", score: 60 }, { subjectName: "Science", score: 60 }] })).toBeNull();
    expect(assessPupil({ ...down(60), previous: null, previousTermLabel: null })).toBeNull();
  });
  it("too few subjects either term (marks still coming in) is not a drop", () => {
    expect(assessPupil({ ...fine, marks: [{ subjectName: "English", score: 55 }, { subjectName: "Maths", score: 55 }] })).toBeNull();
    expect(assessPupil({ ...down(55), previous: { subjects: 2, average: 80 } })).toBeNull();
  });
});

describe("FAILING_SUBJECTS", () => {
  const marks = [
    { subjectName: "English", score: 38 },
    { subjectName: "Mathematics", score: 45.5 },
    { subjectName: "Science", score: 72 },
    { subjectName: "French", score: 49.9 },
  ];
  it("2+ subjects below the pass mark, lowest named", () => {
    const a = assessPupil({ ...fine, marks, previous: null });
    expect(kinds(a)).toEqual(["FAILING_SUBJECTS"]);
    expect(a.reasons[0].statement).toBe("3 of 4 subjects below the pass mark of 50 this term. Lowest: English (38), Mathematics (45.5), French (49.9).");
    expect(a.riskScore).toBe(12);
    expect(a.level).toBe("MEDIUM");
  });
  it("one subject below is not several; the B8 pass mark moves the line", () => {
    expect(assessPupil({ ...fine, marks: [...fine.marks, { subjectName: "French", score: 30 }], previous: null })).toBeNull();
    const a = assessPupil({ ...fine, marks, previous: null, passMark: 40 });
    expect(a).toBeNull(); // only English is below 40
  });
  it("pass mark from the B8 bands: the first band that isn't a fail; none -> null (default 50)", () => {
    expect(passMarkFromBands(DEFAULT_PRIMARY_BANDS)).toBe(40);
    expect(passMarkFromBands(DEFAULT_JHS_BANDS)).toBe(40);
    expect(passMarkFromBands([{ remark: "Weak", minScore: 0 }, { remark: "Good", minScore: 50 }])).toBeNull();
    expect(passMarkFromBands([])).toBeNull();
    expect(passMarkFromBands(undefined)).toBeNull();
    expect(assessPupil({ ...fine, marks, previous: null, passMark: null }).reasons[0].figures).toContainEqual({ label: "Pass mark", value: 50, unit: "score" });
  });
  it("summariseMarks ignores empty scores", () => {
    expect(summariseMarks([{ subjectName: "A", score: null }, { subjectName: "B", score: 40 }], 50)).toEqual({ subjects: 1, average: 40, below: [{ name: "B", score: 40 }] });
  });
});

describe("KG classes", () => {
  it("no score reasons (learning areas, not subjects); attendance and fees still count", () => {
    const kg = { ...fine, isKg: true, marks: [{ subjectName: "x", score: 1 }, { subjectName: "y", score: 2 }], previous: { subjects: 5, average: 90 } };
    expect(assessPupil(kg)).toBeNull();
    expect(kinds(assessPupil({ ...kg, attendance: { marked: 20, present: 10 }, owing: 300 }))).toEqual(["LOW_ATTENDANCE", "OWING"]);
  });
});

describe("OWING", () => {
  it("at or over the line, open term only; credit (negative) never", () => {
    const a = assessPupil({ ...fine, owing: 100 });
    expect(kinds(a)).toEqual(["OWING"]);
    expect(a.reasons[0].statement).toBe("Owes GH₵ 100.00 in fees, at or over the GH₵ 100.00 line.");
    expect(a.level).toBe("LOW");
    expect(assessPupil({ ...fine, owing: 99.99 })).toBeNull();
    expect(assessPupil({ ...fine, owing: -500 })).toBeNull();
    expect(assessPupil({ ...fine, owing: null })).toBeNull();
    expect(assessPupil({ ...fine, owing: 500, openTerm: false })).toBeNull();
  });
  it("the line comes from the thresholds", () => {
    expect(assessPupil({ ...fine, owing: 150 }, { owingThresholdGhs: 200 })).toBeNull();
  });
});

describe("level and order", () => {
  it("three reasons is HIGH whatever the score", () => {
    const a = assessPupil({ ...fine, owing: 120, attendance: { marked: 40, present: 35 }, marks: [{ subjectName: "A", score: 40 }, { subjectName: "B", score: 45 }, { subjectName: "C", score: 70 }], previous: null });
    expect(kinds(a)).toEqual(["LOW_ATTENDANCE", "FAILING_SUBJECTS", "OWING"]);
    expect(a.level).toBe("HIGH");
  });
  it("levelFor lines", () => {
    expect(levelFor(4, 1)).toBe("LOW");
    expect(levelFor(12, 1)).toBe("MEDIUM");
    expect(levelFor(5, 2)).toBe("MEDIUM");
    expect(levelFor(24, 1)).toBe("HIGH");
  });
  it("score, then reasons, then name, then id", () => {
    const e = (studentId, name, riskScore, n = 1) => ({ studentId, name, riskScore, reasons: Array(n).fill({}) });
    expect(orderWatchlist([e(1, "Zed", 10), e(2, "Ama", 10), e(3, "Kofi", 20), e(4, "Yaw", 10, 2), e(5, "Ama", 10)]).map((x) => x.studentId)).toEqual([3, 4, 2, 5, 1]);
  });
});

describe("fingerprint and status", () => {
  const a = assessPupil({ ...fine, owing: 300 });
  it("changes when a figure moves", () => {
    expect(fingerprintOf(a.reasons)).toBe(fingerprintOf(assessPupil({ ...fine, owing: 300 }).reasons));
    expect(fingerprintOf(a.reasons)).not.toBe(fingerprintOf(assessPupil({ ...fine, owing: 301 }).reasons));
  });
  it("dismissed stays dismissed until a NEW reason appears; handled stays handled", () => {
    expect(effectiveStatus(null, a.reasons)).toEqual({ state: "OPEN", reopened: false });
    expect(effectiveStatus({ status: "DISMISSED", statusKinds: ["OWING"] }, a.reasons).state).toBe("DISMISSED");
    const more = assessPupil({ ...fine, owing: 300, attendance: { marked: 40, present: 30 } });
    expect(effectiveStatus({ status: "DISMISSED", statusKinds: ["OWING"] }, more.reasons)).toEqual({ state: "OPEN", reopened: true, newKinds: ["LOW_ATTENDANCE"] });
    expect(effectiveStatus({ status: "HANDLING", statusKinds: ["OWING"] }, more.reasons).state).toBe("HANDLING");
  });
});
