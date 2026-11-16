// AI-5: the briefing run end to end with the models and the SQL mocked and
// the fake AI provider: QUIET = no call, the AI write-up and its figure check,
// the over-budget / AI-failed plain fallback, idempotency per day, Run now
// replacing today's, delivery on the chosen channels only, and nothing of the
// head teacher's address / number (or pupils' contacts) sent to the AI.
process.env.NODE_ENV = "test";

const { Op } = require("sequelize");

// ---------------------------------------------------------------- in-memory Ai_briefing
const mockDb = { briefings: [], nextId: 1, settings: null, aiSettings: null, spent: 0, term: null, admins: ["admin", "head"] };
const mockMatch = (row, where = {}) =>
  Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      return Object.getOwnPropertySymbols(cond).every((sym) => {
        const v = cond[sym];
        if (sym === Op.ne) return row[k] !== v;
        if (sym === Op.lt) return row[k] < v;
        if (sym === Op.gte) return row[k] >= v;
        if (sym === Op.not) return row[k] !== v;
        throw new Error("op");
      });
    }
    return row[k] === cond;
  }) &&
  (where[Op.or] ? where[Op.or].some((w) => mockMatch(row, w)) : true);

jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  const sortRows = (rows) => [...rows].sort((a, b) => (a.briefingDate < b.briefingDate ? 1 : a.briefingDate > b.briefingDate ? -1 : b.briefingId - a.briefingId));
  return {
    __esModule: true,
    ...actual,
    AiBriefing: {
      create: jest.fn(async (r) => {
        if (mockDb.briefings.some((b) => b.runKey === r.runKey)) {
          const e = new Error("duplicate key");
          e.name = "SequelizeUniqueConstraintError";
          throw e;
        }
        const row = { ...r, briefingId: mockDb.nextId++ };
        mockDb.briefings.push(row);
        return row;
      }),
      update: jest.fn(async (patch, { where }) => {
        const rows = mockDb.briefings.filter((b) => mockMatch(b, where));
        rows.forEach((b) => Object.assign(b, patch));
        return [rows.length];
      }),
      findOne: jest.fn(async ({ where = {} } = {}) => {
        const r = sortRows(mockDb.briefings).find((b) => mockMatch(b, where));
        return r ? { ...r } : null;
      }),
      findAll: jest.fn(async ({ where = {}, limit } = {}) => sortRows(mockDb.briefings).filter((b) => mockMatch(b, where)).slice(0, limit || 1000)),
      findAndCountAll: jest.fn(async ({ where = {}, limit, offset }) => {
        const rows = sortRows(mockDb.briefings).filter((b) => mockMatch(b, where));
        return { rows: rows.slice(offset, offset + limit), count: rows.length };
      }),
    },
    AiBriefingSettings: {
      findOne: jest.fn(async () => mockDb.settings && { ...mockDb.settings }),
      upsert: jest.fn(async (r) => {
        mockDb.settings = { ...r };
      }),
    },
    AiSettings: { findOne: jest.fn(async () => ({ ...mockDb.aiSettings })) },
    AiUsageLog: { create: jest.fn(async (r) => r), sum: jest.fn(async () => mockDb.spent), findAll: jest.fn(async () => []) },
    Term: { findOne: jest.fn(async () => mockDb.term) },
    UserAccount: { findAll: jest.fn(async () => mockDb.admins.map((username) => ({ username }))) },
  };
});

jest.mock("../services/briefing/data.js", () => ({
  attendanceByClass: jest.fn(async () => []),
  absenceByPupil: jest.fn(async () => []),
  feesByWeek: jest.fn(async () => []),
  owingSummary: jest.fn(async () => ({ count: 0, total: 0, onRoll: 0, byClass: [] })),
  staffAbsences: jest.fn(async () => []),
  unmarkedRegisters: jest.fn(async () => ({ schoolDays: 0, rows: [] })),
}));
jest.mock("../services/notify.js", () => {
  const actual = jest.requireActual("../services/notify.js");
  return {
    __esModule: true,
    ...actual,
    notify: jest.fn(async ({ recipients }) => ({ inApp: recipients.length, emails: 0, done: Promise.resolve() })),
    sendEmailBatch: jest.fn(async () => ({ sent: 0, logged: 1, failed: 0 })),
    findMissingScores: jest.fn(async () => []),
  };
});
jest.mock("../services/whatsapp.js", () => {
  const actual = jest.requireActual("../services/whatsapp.js");
  return { __esModule: true, ...actual, sendWhatsApp: jest.fn(async () => ({ status: "LOGGED" })) };
});
jest.mock("../services/school.js", () => ({ getSchoolSettings: jest.fn(async () => ({ name: "Perfect Peace School" })) }));

const data = require("../services/briefing/data.js");
const notifyMod = require("../services/notify.js");
const wa = require("../services/whatsapp.js");
const { setAiProviderForTests } = require("../services/ai/client.js");
const { createFakeProvider } = require("../services/ai/providers/fake.js");
const { clearAiSettingsCache } = require("../services/ai/settings.js");
const { runBriefing, latestBriefing, listBriefings, getBriefing, briefingProblem } = require("../services/briefing/service.js");
const { briefingTick, __resetBriefingScheduler } = require("../services/briefing/scheduler.js");

const MONDAY_6AM = new Date("2026-11-16T06:00:00Z");
const ENV = { ...process.env };
const HEAD_EMAIL = "head.teacher@example.com";
const HEAD_WA = "233241234567";

const term = { termId: 7, term: "1", active: true, startDate: "2026-09-08", endDate: "2026-12-18" };

// One staff absence + one class dip: two signals.
const withSignals = () => {
  data.staffAbsences.mockResolvedValue([{ teacherId: 3, name: "Kofi Boateng", weekAbsences: 3 }]);
  data.attendanceByClass.mockResolvedValue([{ classId: 4, className: "P5", weekMarked: 100, weekPresent: 80, baselineMarked: 400, baselinePresent: 360 }]);
};
const STAFF_KEY = "staff-absence:3:2026-11-09";
const DIP_KEY = "attendance-dip:4:2026-11-09";
const goodAnswer = {
  headline: "P5 attendance fell to 80% and a teacher was away 3 days",
  summary: "Two things this week: attendance in P5 dropped and one member of staff was absent on several days.",
  items: [
    { signalKey: DIP_KEY, headline: "P5 attendance down to 80%", body: "P5 attendance was 80% in the last 7 days, against 90% before, a fall of 10 points.", whatToDoNext: "Ask the P5 class teacher which pupils were away and call their families." },
    { signalKey: STAFF_KEY, headline: "Kofi Boateng absent 3 days", body: "Kofi Boateng was marked absent on 3 days in the last 7 days.", whatToDoNext: "The head teacher should speak with him and check his lessons were covered." },
  ],
};
const inventedAnswer = { ...goodAnswer, items: [{ ...goodAnswer.items[0], body: "P5 attendance was 80%, and 14 pupils missed every day this week." }] };

let provider;
const useProvider = (script) => {
  provider = createFakeProvider(script);
  setAiProviderForTests(provider);
};

beforeEach(() => {
  process.env = { ...ENV, AI_ENABLED: "true", GEMINI_API_KEY: "test-key" };
  mockDb.briefings = [];
  mockDb.nextId = 1;
  mockDb.settings = { briefingSettingsId: 1, days: [1], runTime: "06:00", owingThresholdGhs: "100.00", emailEnabled: false, emailTo: HEAD_EMAIL, whatsappEnabled: false, whatsappTo: HEAD_WA };
  mockDb.aiSettings = { aiSettingsId: 1, enabled: true, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
  mockDb.spent = 0;
  mockDb.term = term;
  clearAiSettingsCache();
  __resetBriefingScheduler();
  for (const fn of Object.values(data)) fn.mockReset();
  data.attendanceByClass.mockResolvedValue([]);
  data.absenceByPupil.mockResolvedValue([]);
  data.feesByWeek.mockResolvedValue([]);
  data.owingSummary.mockResolvedValue({ count: 0, total: 0, onRoll: 0, byClass: [] });
  data.staffAbsences.mockResolvedValue([]);
  data.unmarkedRegisters.mockResolvedValue({ schoolDays: 0, rows: [] });
  useProvider([{ json: goodAnswer }]);
});
afterAll(() => {
  setAiProviderForTests(null);
  process.env = ENV;
});

describe("QUIET", () => {
  it("no signals: no AI call, no cost, nobody notified, still stored", async () => {
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b).toMatchObject({ date: "2026-11-16", status: "QUIET", source: null, costGhs: 0, itemCount: 0 });
    expect(b.headline).toMatch(/quiet week/i);
    expect(provider.calls).toHaveLength(0);
    expect(notifyMod.notify).not.toHaveBeenCalled();
    expect(wa.sendWhatsApp).not.toHaveBeenCalled();
  });
  it("news already said in a recent briefing (term-scoped key) is not repeated", async () => {
    data.owingSummary.mockResolvedValue({ count: 12, total: 2400, onRoll: 100, byClass: [] });
    mockDb.briefings.push({ briefingId: 99, runKey: "2026-11-09", briefingDate: "2026-11-09", status: "READY", content: { items: [{ signalKey: "owing:7:100:1" }] } });
    mockDb.nextId = 100;
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b.status).toBe("QUIET");
    expect(b.content.suppressedCount).toBe(1);
    expect(b.signals[0]).toMatchObject({ key: "owing:7:100:1", suppressed: true });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("grouped chronic absences", () => {
  const pupil = (id) => ({ studentId: id, name: `Pupil ${id}`, className: "P5", markedToDate: 20, missedToDate: 3, markedBefore: 15, missedBefore: 1 });
  it("are one item, and the pupils in it are not repeated next time", async () => {
    data.absenceByPupil.mockResolvedValue([1, 2, 3, 4, 5].map(pupil));
    mockDb.spent = 999; // plain, no AI needed
    const first = await runBriefing({ now: new Date("2026-11-12T06:00:00Z") });
    expect(first.content.items).toHaveLength(1);
    expect(first.content.items[0]).toMatchObject({ signalKey: "chronic-absence-group:7:2026-11-12", headline: "5 pupils now chronically absent" });
    const next = await runBriefing({ now: MONDAY_6AM });
    expect(next.status).toBe("QUIET");
    expect(next.content.suppressedCount).toBe(5);
  });
});

describe("AI write-up", () => {
  it("writes READY from the model, ties items to signals and records the model", async () => {
    withSignals();
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b).toMatchObject({ status: "READY", source: "AI", fallbackReason: null, itemCount: 2, trigger: "SCHEDULE" });
    expect(b.content.items[0]).toMatchObject({ signalKey: DIP_KEY, kind: "ATTENDANCE_DIP", statement: expect.stringContaining("80%") });
    expect(b.promptVersion).toBe("briefing@1.0.0");
    expect(provider.calls).toHaveLength(1);
  });
  it("rejects an answer with an invented figure, retries once, then falls back to the plain list", async () => {
    withSignals();
    useProvider([{ json: inventedAnswer }]);
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(provider.calls).toHaveLength(2);
    expect(b).toMatchObject({ status: "READY", source: "PLAIN", fallbackReason: "AI_FAILED" });
    expect(b.content.items.map((i) => i.body)).toEqual(b.content.items.map((i) => i.statement));
  });
  it("accepts a corrected second answer", async () => {
    withSignals();
    useProvider([{ json: inventedAnswer }, { json: goodAnswer }]);
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b.source).toBe("AI");
    expect(provider.calls[1].messages.at(-1).content).toMatch(/not supplied: 14/);
  });
  it("briefingProblem: unknown key, duplicate key, too many items", () => {
    const signals = [{ signalKey: "a", subject: "A", statement: "5 days", figures: [] }];
    const ctx = { signals, window: {}, today: "x", maxItems: 1 };
    const item = { signalKey: "a", headline: "Five days away", body: "Away on 5 days this week.", whatToDoNext: "Call the family today." };
    const base = { headline: "One pupil to call today", summary: "One pupil was away on 5 days and needs a call." };
    expect(briefingProblem({ ...base, items: [item] }, ctx)).toBeNull();
    expect(briefingProblem({ ...base, items: [{ ...item, signalKey: "zzz" }] }, ctx)).toMatch(/not sent/);
    expect(briefingProblem({ ...base, items: [item, item] }, { ...ctx, maxItems: 2 })).toMatch(/twice/);
    expect(briefingProblem({ ...base, items: [item, item] }, ctx)).toMatch(/at most 1/);
    expect(briefingProblem({ ...base, headline: "Seven pupils away: 7" , items: [item] }, ctx)).toMatch(/headline quotes/);
  });
  it("sends no contact data and not the head teacher's address or number to the AI", async () => {
    withSignals();
    data.absenceByPupil.mockResolvedValue([{ studentId: 9, name: "Ama Mensah 0244123456", className: "JHS 1", markedToDate: 20, missedToDate: 3, markedBefore: 15, missedBefore: 1 }]);
    mockDb.settings = { ...mockDb.settings, emailEnabled: true, whatsappEnabled: true };
    useProvider([(req) => ({ json: { ...goodAnswer, items: [goodAnswer.items[0]] } })]);
    await runBriefing({ now: MONDAY_6AM });
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).not.toContain("0244123456");
    expect(sent).not.toContain(HEAD_EMAIL);
    expect(sent).not.toContain("241234567");
    expect(sent).toContain("Ama Mensah");
  });
});

describe("over the budget / AI off", () => {
  it("over the cap: the plain list, marked, no AI call", async () => {
    withSignals();
    mockDb.spent = 150;
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b).toMatchObject({ status: "READY", source: "PLAIN", fallbackReason: "QUOTA", costGhs: 0 });
    expect(b.summary).toMatch(/budget is used up/);
    expect(b.content.items).toHaveLength(2);
    expect(provider.calls).toHaveLength(0);
    expect(notifyMod.notify).toHaveBeenCalledTimes(1); // still delivered
  });
  it("switched off between the gate and the call: plain, AI_OFF", async () => {
    withSignals();
    mockDb.aiSettings.featureToggles = { BRIEFING: false };
    const b = await runBriefing({ now: MONDAY_6AM, trigger: "MANUAL", user: { category: "Administrator", username: "admin" } });
    expect(b).toMatchObject({ source: "PLAIN", fallbackReason: "AI_OFF" });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("idempotency (one briefing per Accra day)", () => {
  it("a second scheduled run the same day does nothing", async () => {
    withSignals();
    await runBriefing({ now: MONDAY_6AM });
    const again = await runBriefing({ now: new Date("2026-11-16T06:05:00Z") });
    expect(again).toEqual({ skipped: "ALREADY_DONE", date: "2026-11-16" });
    expect(mockDb.briefings).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });
  it("another instance's run in progress is left alone; a dead one (15+ min) is taken over", async () => {
    mockDb.briefings.push({ briefingId: 1, runKey: "2026-11-16", briefingDate: "2026-11-16", status: "RUNNING", updatedAt: new Date("2026-11-16T05:55:00Z") });
    mockDb.nextId = 2;
    expect(await runBriefing({ now: MONDAY_6AM })).toMatchObject({ skipped: "ALREADY_DONE" });
    const later = await runBriefing({ now: new Date("2026-11-16T06:20:00Z") });
    expect(later.status).toBe("QUIET");
    expect(mockDb.briefings).toHaveLength(1);
  });
  it("Run now replaces today's briefing in place (same row) and records who", async () => {
    await runBriefing({ now: MONDAY_6AM });
    withSignals();
    const b = await runBriefing({ now: new Date("2026-11-16T09:00:00Z"), trigger: "MANUAL", user: { category: "Administrator", username: "admin" } });
    expect(mockDb.briefings).toHaveLength(1);
    expect(b).toMatchObject({ briefingId: 1, status: "READY", trigger: "MANUAL", runBy: "admin" });
  });
  it("Run now while today's is being made is a 409", async () => {
    mockDb.briefings.push({ briefingId: 1, runKey: "2026-11-16", briefingDate: "2026-11-16", status: "RUNNING", updatedAt: new Date("2026-11-16T08:59:00Z") });
    await expect(runBriefing({ now: new Date("2026-11-16T09:00:00Z"), trigger: "MANUAL", user: { category: "Administrator", username: "admin" } })).rejects.toMatchObject({ statusCode: 409 });
  });
  it("the day is the Accra date: 23:59 Sunday and 00:01 Monday are different days", async () => {
    await runBriefing({ now: new Date("2026-11-15T23:59:00Z") });
    await runBriefing({ now: new Date("2026-11-16T00:01:00Z") });
    expect(mockDb.briefings.map((b) => b.runKey)).toEqual(["2026-11-15", "2026-11-16"]);
  });
  it("a failure reading the figures stores FAILED with the reason", async () => {
    mockDb.term = null;
    data.owingSummary.mockRejectedValue(new Error("relation missing"));
    data.staffAbsences.mockRejectedValue(new Error("relation missing"));
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b).toMatchObject({ status: "FAILED", error: expect.stringContaining("No figures") });
  });
  it("one collector failing is skipped and named; the rest still work", async () => {
    withSignals();
    data.absenceByPupil.mockRejectedValue(new Error("boom"));
    const b = await runBriefing({ now: MONDAY_6AM });
    expect(b.status).toBe("READY");
    expect(b.content.skipped).toEqual([{ kind: "CHRONIC_ABSENCE", error: "boom" }]);
  });
});

describe("delivery: in-app always, email and/or WhatsApp only when chosen", () => {
  const run = async (emailEnabled, whatsappEnabled) => {
    mockDb.settings = { ...mockDb.settings, emailEnabled, whatsappEnabled };
    withSignals();
    return runBriefing({ now: MONDAY_6AM });
  };
  it("neither: only the in-app notice to every Administrator", async () => {
    const b = await run(false, false);
    expect(notifyMod.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "AI_BRIEFING", recipients: [{ type: "OFFICE", id: "admin" }, { type: "OFFICE", id: "head" }], link: "/briefings" }));
    expect(notifyMod.sendEmailBatch).not.toHaveBeenCalled();
    expect(wa.sendWhatsApp).not.toHaveBeenCalled();
    expect(b.delivered).toMatchObject({ inApp: 2, email: null, whatsapp: null });
  });
  it("email only", async () => {
    const b = await run(true, false);
    expect(notifyMod.sendEmailBatch).toHaveBeenCalledTimes(1);
    expect(notifyMod.sendEmailBatch.mock.calls[0][1][0]).toMatchObject({ to: HEAD_EMAIL, subject: expect.stringContaining("P5") });
    expect(wa.sendWhatsApp).not.toHaveBeenCalled();
    expect(b.delivered.email).toEqual({ status: "LOGGED", to: "h***@example.com" });
  });
  it("WhatsApp only", async () => {
    const b = await run(false, true);
    expect(wa.sendWhatsApp).toHaveBeenCalledWith({ to: HEAD_WA, text: expect.stringContaining("Kofi Boateng") });
    expect(notifyMod.sendEmailBatch).not.toHaveBeenCalled();
    expect(b.delivered.whatsapp).toMatchObject({ status: "LOGGED", to: "+23324***67" });
  });
  it("both", async () => {
    await run(true, true);
    expect(notifyMod.sendEmailBatch).toHaveBeenCalledTimes(1);
    expect(wa.sendWhatsApp).toHaveBeenCalledTimes(1);
  });
  it("a failed WhatsApp send is recorded and doesn't fail the briefing", async () => {
    wa.sendWhatsApp.mockResolvedValueOnce({ status: "FAILED", error: "131047 Re-engagement message" });
    const b = await run(false, true);
    expect(b.status).toBe("READY");
    expect(b.delivered.whatsapp).toMatchObject({ status: "FAILED", error: expect.stringContaining("131047") });
  });
});

describe("reads", () => {
  it("latest, history and one", async () => {
    await runBriefing({ now: new Date("2026-11-09T06:00:00Z") });
    withSignals();
    await runBriefing({ now: MONDAY_6AM });
    const latest = await latestBriefing(MONDAY_6AM);
    expect(latest).toMatchObject({ running: false, briefing: { date: "2026-11-16", status: "READY" } });
    const list = await listBriefings({});
    expect(list.briefings.map((b) => b.date)).toEqual(["2026-11-16", "2026-11-09"]);
    expect(list.briefings[0].content).toBeUndefined();
    expect((await getBriefing(list.briefings[1].briefingId)).status).toBe("QUIET");
    await expect(getBriefing("abc")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("scheduler tick", () => {
  it("runs once on a chosen day after the time, then knows the day is done", async () => {
    expect(await briefingTick(new Date("2026-11-16T05:59:00Z"))).toBe("NOT_DUE");
    expect(await briefingTick(MONDAY_6AM)).toBe("RAN");
    expect(await briefingTick(new Date("2026-11-16T06:01:00Z"))).toBe("DONE");
    expect(mockDb.briefings).toHaveLength(1);
  });
  it("a restart later the same day doesn't make a second one", async () => {
    await briefingTick(MONDAY_6AM);
    __resetBriefingScheduler(); // a new process
    expect(await briefingTick(new Date("2026-11-16T10:00:00Z"))).toBe("DONE");
    expect(mockDb.briefings).toHaveLength(1);
  });
  it("a run that died (API restart) is left alone while fresh, then reclaimed after 15 minutes", async () => {
    const t0 = new Date("2026-11-16T08:00:00Z");
    mockDb.briefings.push({
      briefingId: mockDb.nextId++, runKey: "2026-11-16", briefingDate: "2026-11-16", status: "RUNNING", source: null,
      fallbackReason: null, signals: [], content: null, delivered: {}, costGhs: 0, error: null,
      runTrigger: "SCHEDULE", runBy: null, createdAt: new Date(t0.getTime() - 60_000), updatedAt: new Date(t0.getTime() - 60_000),
    });
    __resetBriefingScheduler(); // the new process after the restart
    expect(await briefingTick(t0)).toBe("RUNNING"); // updated 1 minute ago: does nothing
    expect(mockDb.briefings[0].status).toBe("RUNNING");
    expect(await briefingTick(new Date(t0.getTime() + 16 * 60_000))).toBe("RAN"); // stale: reclaimed and finished
    expect(mockDb.briefings).toHaveLength(1);
    expect(mockDb.briefings[0].status).not.toBe("RUNNING");
    expect(await briefingTick(new Date(t0.getTime() + 17 * 60_000))).toBe("DONE");
  });
  it("catches up after downtime the same day", async () => {
    expect(await briefingTick(new Date("2026-11-16T11:00:00Z"))).toBe("RAN");
  });
  it("not on other days, and not when the school or the feature is off", async () => {
    expect(await briefingTick(new Date("2026-11-17T06:00:00Z"))).toBe("NOT_DUE");
    mockDb.aiSettings.enabled = false;
    clearAiSettingsCache();
    expect(await briefingTick(MONDAY_6AM)).toBe("OFF");
    expect(mockDb.briefings).toHaveLength(0);
  });
  it("follows the chosen days and time", async () => {
    mockDb.settings = { ...mockDb.settings, days: [2, 4], runTime: "07:30" };
    expect(await briefingTick(new Date("2026-11-17T07:29:00Z"))).toBe("NOT_DUE");
    expect(await briefingTick(new Date("2026-11-17T07:30:00Z"))).toBe("RAN");
  });
});
