// AI-5: the briefing's arithmetic (each signal's maths and edge cases), the
// unsupported-figures check and the schedule in Africa/Accra. Pure functions.
import {
  DEFAULT_THRESHOLDS as T,
  allowedFigureTokens,
  attendanceDipSignal,
  attendanceRate,
  chronicAbsenceSignal,
  collectionDropSignal,
  extractFigureTokens,
  groupChronicSignals,
  median,
  normaliseFigureToken,
  owingSignal,
  plainItems,
  rankSignals,
  resultsGapsSignal,
  staffAbsenceSignal,
  unmarkedRegistersSignal,
  unsupportedFigures,
} from "../services/briefing/signals.js";
import { accraInstant, accraParts, addDays, cleanDays, daysBetween, describeSchedule, isDue, nextRunAt, weekdayOf } from "../services/briefing/schedule.js";
import { windowFor } from "../services/briefing/service.js";

const W = { weekStart: "2026-11-09", weekEnd: "2026-11-16", date: "2026-11-16" };

describe("attendance dip by class", () => {
  const row = { classId: 4, className: "Primary 5 ", weekMarked: 100, weekPresent: 80, baselineMarked: 400, baselinePresent: 360 };

  it("fires when the class falls 5+ points below its own rate", () => {
    const s = attendanceDipSignal(row, W);
    expect(s).toMatchObject({ kind: "ATTENDANCE_DIP", key: "attendance-dip:4:2026-11-09", subject: "Primary 5" });
    expect(s.figures.map((f) => f.value)).toEqual([80, 90, 10, 100]);
    expect(s.statement).toContain("80% in the last 7 days, against 90%");
  });
  it("stays quiet for a small fall", () => {
    expect(attendanceDipSignal({ ...row, weekPresent: 87 }, W)).toBeNull(); // 87 vs 90 = 3 points
  });
  it("fires exactly at the line (5 points)", () => {
    expect(attendanceDipSignal({ ...row, weekPresent: 85 }, W)).not.toBeNull();
  });
  it("needs a baseline: a new term (few marks before) says nothing", () => {
    expect(attendanceDipSignal({ ...row, baselineMarked: 0, baselinePresent: 0 }, W)).toBeNull();
    expect(attendanceDipSignal({ ...row, baselineMarked: 19, baselinePresent: 19 }, W)).toBeNull();
  });
  it("needs enough marks in the week", () => {
    expect(attendanceDipSignal({ ...row, weekMarked: 10, weekPresent: 2 }, W)).toBeNull();
  });
  it("rate is null with nothing marked, 1 dp otherwise", () => {
    expect(attendanceRate(0, 0)).toBeNull();
    expect(attendanceRate(2, 3)).toBe(66.7);
  });
});

describe("chronic absentees (crossing the line this week)", () => {
  const row = { studentId: 9, name: "Ama Mensah", className: "JHS 1", markedToDate: 20, missedToDate: 3, markedBefore: 15, missedBefore: 1 };
  it("fires on the crossing, keyed on the term", () => {
    const s = chronicAbsenceSignal(row, 7);
    expect(s).toMatchObject({ key: "chronic-absence:9:7", subject: "Ama Mensah" });
    expect(s.figures.find((f) => f.label === "Share away").value).toBe(15);
    expect(s.statement).toContain("3 of 20 marked days");
  });
  it("is quiet when the pupil was already over the line", () => {
    expect(chronicAbsenceSignal({ ...row, missedBefore: 2 }, 7)).toBeNull(); // 2/15 = 13% before
  });
  it("is quiet below the line", () => {
    expect(chronicAbsenceSignal({ ...row, missedToDate: 1 }, 7)).toBeNull();
  });
  it("needs 10 marked days (start of term: nobody has crossed anything)", () => {
    expect(chronicAbsenceSignal({ ...row, markedToDate: 9, missedToDate: 5, markedBefore: 4, missedBefore: 0 }, 7)).toBeNull();
  });
  it("counts a pupil under the minimum before the window as not over", () => {
    expect(chronicAbsenceSignal({ ...row, markedToDate: 12, missedToDate: 4, markedBefore: 7, missedBefore: 3 }, 7)).not.toBeNull();
  });
});

describe("many chronic crossings become one signal", () => {
  const crossing = (id, missed) => chronicAbsenceSignal({ studentId: id, name: `Pupil ${id}`, className: "P5", markedToDate: 20, missedToDate: missed, markedBefore: 15, missedBefore: 1 }, 7);
  it("3 stay separate", () => {
    const list = [crossing(1, 3), crossing(2, 3), crossing(3, 4)];
    expect(groupChronicSignals(list, 7, "2026-11-16")).toHaveLength(3);
  });
  it("4+ become one, worst named first, carrying each pupil's key", () => {
    const other = staffAbsenceSignal({ teacherId: 3, name: "Kofi", weekAbsences: 2 }, W);
    const out = groupChronicSignals([crossing(1, 3), crossing(2, 6), crossing(3, 4), crossing(4, 3), other], 7, "2026-11-16");
    expect(out).toHaveLength(2);
    const g = out.find((s) => s.kind === "CHRONIC_ABSENCE");
    expect(g.key).toBe("chronic-absence-group:7:2026-11-16");
    expect(g.statement).toMatch(/^4 pupils crossed the 10% chronic absence line in the last 7 days: Pupil 2 \(30%\), Pupil 3 \(20%\)/);
    expect(g.memberKeys.sort()).toEqual(["chronic-absence:1:7", "chronic-absence:2:7", "chronic-absence:3:7", "chronic-absence:4:7"]);
    expect(plainItems([g])[0].memberKeys).toHaveLength(4);
  });
});

describe("fees collected vs recent weeks", () => {
  const weeks = (b0, ...rest) => [{ bucket: 0, total: b0, payments: 3 }, ...rest.map((t, i) => ({ bucket: i + 1, total: t, payments: 5 }))];
  it("fires when the week is 40%+ below a normal (median) week", () => {
    const s = collectionDropSignal(weeks(500, 1000, 1200, 800, 1000), W);
    expect(s.figures.map((f) => f.value)).toEqual([500, 1000, 50, 3]);
    expect(s.statement).toContain("GH₵ 500.00");
  });
  it("uses the median, so one start-of-term rush week doesn't make every week a drop", () => {
    expect(collectionDropSignal(weeks(900, 9000, 1000, 1000, 1000), W)).toBeNull(); // mean 3000, median 1000
  });
  it("no baseline (nothing taken in the weeks before) is not a drop", () => {
    expect(collectionDropSignal(weeks(0), W)).toBeNull();
    expect(collectionDropSignal([], W)).toBeNull();
  });
  it("a week with no payments at all against a normal baseline fires", () => {
    const s = collectionDropSignal([{ bucket: 2, total: 1000, payments: 4 }, { bucket: 3, total: 1000 }, { bucket: 1, total: 1000 }, { bucket: 4, total: 1000 }], W);
    expect(s.figures[0].value).toBe(0);
    expect(s.figures[2].value).toBe(100);
  });
  it("median helper", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("pupils owing more than the line", () => {
  it("states count, total, share and the worst classes; keyed on term, line and band", () => {
    const s = owingSignal({ count: 23, total: 5400.5, onRoll: 200, byClass: [{ className: "P4", count: 8 }, { className: "P2", count: 5 }] }, 7, { ...T, owingThresholdGhs: 100 });
    expect(s.key).toBe("owing:7:100:2");
    expect(s.statement).toBe("23 pupils owe GH₵ 100.00 or more, GH₵ 5,401.00 in all, 11.5% of the 200 on roll. Most in P4 (8), P2 (5).");
  });
  it("uses the configured line", () => {
    expect(owingSignal({ count: 2, total: 900, onRoll: 50, byClass: [] }, 7, { ...T, owingThresholdGhs: 400 }).subject).toBe("Pupils owing GH₵ 400.00 or more");
  });
  it("is quiet when nobody owes that much", () => {
    expect(owingSignal({ count: 0, total: 0, onRoll: 50 }, 7)).toBeNull();
  });
  it("works with no open term", () => {
    expect(owingSignal({ count: 1, total: 150, onRoll: 0, byClass: [] }, null).key).toBe("owing:none:100:0");
  });
});

describe("results entry gaps", () => {
  const rows = [
    { className: "P5", subjectName: "Maths", missing: 12, expected: 30 },
    { className: "P6", subjectName: "Science", missing: 0, expected: 28 },
    { className: "JHS 1", subjectName: "English", missing: 3, expected: 25 },
  ];
  const ctx = { termId: 7, termLabel: "Term 1", date: "2026-11-30", daysToEnd: 10 };
  it("fires near the end of term with the totals and worst sheets", () => {
    const s = resultsGapsSignal(rows, ctx);
    expect(s.figures.slice(0, 3).map((f) => f.value)).toEqual([15, 2, 10]);
    expect(s.statement).toContain("Maths in P5 (12 of 30)");
  });
  it("is quiet early in the term", () => {
    expect(resultsGapsSignal(rows, { ...ctx, daysToEnd: 40 })).toBeNull();
  });
  it("is quiet when the term has no end date", () => {
    expect(resultsGapsSignal(rows, { ...ctx, daysToEnd: null })).toBeNull();
  });
  it("still fires after the end date while the term is open", () => {
    expect(resultsGapsSignal(rows, { ...ctx, daysToEnd: -3 }).statement).toContain("has passed its end date");
  });
  it("is quiet with every score in", () => {
    expect(resultsGapsSignal([{ className: "P5", subjectName: "Maths", missing: 0, expected: 30 }], ctx)).toBeNull();
  });
});

describe("staff absence (B9)", () => {
  it("names staff absent 2+ days", () => {
    const s = staffAbsenceSignal({ teacherId: 3, name: "Kofi Boateng", weekAbsences: 3 }, W);
    expect(s).toMatchObject({ key: "staff-absence:3:2026-11-09", subject: "Kofi Boateng" });
    expect(s.statement).toContain("3 days");
  });
  it("ignores a single day", () => {
    expect(staffAbsenceSignal({ teacherId: 3, name: "Kofi", weekAbsences: 1 }, W)).toBeNull();
  });
});

describe("unmarked registers", () => {
  it("one school-wide signal naming the worst classes", () => {
    const s = unmarkedRegistersSignal([{ classId: 1, className: "KG 1", missed: 2 }, { classId: 2, className: "P3", missed: 4 }, { classId: 3, className: "P4", missed: 0 }], 5, W);
    expect(s.figures.slice(0, 3).map((f) => f.value)).toEqual([6, 2, 5]);
    expect(s.statement).toContain("Most missed: P3 (4), KG 1 (2)");
  });
  it("is quiet below 3 or with no school days (holiday)", () => {
    expect(unmarkedRegistersSignal([{ classId: 1, className: "KG 1", missed: 2 }], 5, W)).toBeNull();
    expect(unmarkedRegistersSignal([{ classId: 1, className: "KG 1", missed: 9 }], 0, W)).toBeNull();
  });
});

describe("ranking and the plain list", () => {
  it("orders by severity, then kind", () => {
    const ranked = rankSignals([
      { key: "b", kind: "OWING", severity: 10 },
      { key: "a", kind: "CHRONIC_ABSENCE", severity: 50 },
      { key: "c", kind: "ATTENDANCE_DIP", severity: 10 },
    ]);
    expect(ranked.map((s) => s.key)).toEqual(["a", "c", "b"]);
  });
  it("plain items carry the computed statement and a next step without figures", () => {
    const s = staffAbsenceSignal({ teacherId: 3, name: "Kofi Boateng", weekAbsences: 3 }, W);
    const [item] = plainItems([s]);
    expect(item).toMatchObject({ signalKey: s.key, headline: "Kofi Boateng", body: s.statement });
    expect(extractFigureTokens(item.whatToDoNext)).toEqual([]);
  });
});

describe("unsupportedFigures", () => {
  const signal = attendanceDipSignal({ classId: 4, className: "JHS 2", weekMarked: 120, weekPresent: 99, baselineMarked: 400, baselinePresent: 360 }, W);
  const allowed = allowedFigureTokens({ signal, window: { from: "2026-11-09", to: "2026-11-15" } });

  it("accepts figures as given, rounded, with separators and currency", () => {
    expect(unsupportedFigures("JHS 2 attendance fell to 83 per cent (82.5%) from 90%.", allowed)).toEqual([]);
    expect(unsupportedFigures("A fall of 7.5 points over 120 marks between 9 and 15 November 2026.", allowed)).toEqual([]);
  });
  it("rejects any number that wasn't supplied", () => {
    expect(unsupportedFigures("Attendance fell to 75% from 90%, 12 pupils were away.", allowed)).toEqual(["75", "12"]);
  });
  it("can't be walked around with grouping or trailing zeros", () => {
    const money = allowedFigureTokens({ v: 12500 });
    expect(unsupportedFigures("GH₵ 12,500.00 taken", money)).toEqual([]);
    expect(unsupportedFigures("GH₵ 12,600.00 taken", money)).toEqual(["12600"]);
  });
  it("normalises tokens", () => {
    expect(normaliseFigureToken("08")).toBe("8");
    expect(normaliseFigureToken("1,234.50")).toBe("1234.5");
    expect(normaliseFigureToken("abc")).toBe("");
  });
});

describe("schedule in Africa/Accra", () => {
  // 2026-11-16 is a Monday. Accra is UTC+0 all year.
  it("reads the civil date, weekday and time in Accra", () => {
    expect(accraParts(new Date("2026-11-16T06:00:00Z"))).toEqual({ date: "2026-11-16", isoWeekday: 1, time: "06:00", minutes: 360 });
    expect(accraParts(new Date("2026-11-15T23:59:00Z"))).toMatchObject({ date: "2026-11-15", isoWeekday: 7 });
  });
  it("is due on a chosen day from the chosen time until midnight", () => {
    const s = { days: [1], runTime: "06:00" };
    expect(isDue(new Date("2026-11-16T05:59:00Z"), s)).toBe(false);
    expect(isDue(new Date("2026-11-16T06:00:00Z"), s)).toBe(true);
    expect(isDue(new Date("2026-11-16T23:30:00Z"), s)).toBe(true); // catch-up after a restart
    expect(isDue(new Date("2026-11-17T06:30:00Z"), s)).toBe(false); // Tuesday
  });
  it("handles several days and another time", () => {
    const s = { days: [1, 4], runTime: "14:30" };
    expect(isDue(new Date("2026-11-19T14:30:00Z"), s)).toBe(true); // Thursday
    expect(isDue(new Date("2026-11-19T14:29:00Z"), s)).toBe(false);
    expect(isDue(new Date("2026-11-18T15:00:00Z"), s)).toBe(false); // Wednesday
  });
  it("no days = never due", () => {
    expect(isDue(new Date("2026-11-16T07:00:00Z"), { days: [], runTime: "06:00" })).toBe(false);
  });
  it("next run: today later, catching up now, or the next chosen day", () => {
    const s = { days: [1, 5], runTime: "06:00" };
    expect(nextRunAt(new Date("2026-11-16T05:00:00Z"), s).toISOString()).toBe("2026-11-16T06:00:00.000Z");
    const now = new Date("2026-11-16T09:00:00Z");
    expect(nextRunAt(now, s)).toBe(now);
    expect(nextRunAt(now, s, { doneToday: true }).toISOString()).toBe("2026-11-20T06:00:00.000Z");
    expect(nextRunAt(new Date("2026-11-21T09:00:00Z"), s).toISOString()).toBe("2026-11-23T06:00:00.000Z");
    expect(nextRunAt(now, { days: [], runTime: "06:00" })).toBeNull();
  });
  it("date helpers", () => {
    expect(addDays("2026-11-16", -7)).toBe("2026-11-09");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-16", "2026-12-18")).toBe(32);
    expect(weekdayOf("2026-11-22")).toBe(7);
    expect(accraInstant("2026-11-16", "06:00").toISOString()).toBe("2026-11-16T06:00:00.000Z");
    expect(cleanDays([3, "1", 1, 9, 0])).toEqual([1, 3]);
    expect(describeSchedule({ days: [1, 4], runTime: "06:00" })).toBe("Mondays and Thursdays at 06:00");
    expect(describeSchedule({ days: [], runTime: "06:00" })).toMatch(/Run now only/);
  });
});

describe("the window", () => {
  it("is the 7 days before, the 4 weeks before that, and keeps the attendance baseline inside the term", () => {
    const w = windowFor("2026-11-16", { termId: 7, term: "1", startDate: "2026-11-02", endDate: "2026-12-18" });
    expect(w).toMatchObject({ weekStart: "2026-11-09", weekEnd: "2026-11-16", lastDay: "2026-11-15", baselineStart: "2026-10-12", attendanceBaselineStart: "2026-11-02", termLabel: "Term 1", daysToEnd: 32 });
  });
  it("without a term: no term figures", () => {
    expect(windowFor("2026-11-16", null)).toMatchObject({ termId: null, attendanceBaselineStart: "2026-10-12", daysToEnd: null });
  });
});
