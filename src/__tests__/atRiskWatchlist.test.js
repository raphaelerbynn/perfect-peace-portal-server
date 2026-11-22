// AI-4: the watchlist end to end through the routes, with the models and the
// SQL mocked and the fake AI provider: who sees what (Administrator
// school-wide, Class Teacher own class only), the list with AI off / over the
// cap, AI notes (figures checked, cached by fingerprint, nothing for dismissed
// pupils, no contact data sent), and being handled / dismissed.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

const mockDb = { entries: [], aiSettings: null, spent: 0, terms: [], classes: [], students: [] };
const mockKey = (r) => `${r.studentId}:${r.termId}`;

jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  const { Op } = jest.requireActual("sequelize");
  const matchClass = (c, where = {}) =>
    (where.classId === undefined || Number(c.classId) === Number(where.classId)) &&
    (where.teacherId === undefined || Number(c.teacherId) === Number(where.teacherId)) &&
    (where.isDeleted === undefined || (typeof where.isDeleted === "object" ? c.isDeleted !== true : c.isDeleted === where.isDeleted));
  return {
    __esModule: true,
    ...actual,
    AiSettings: { findOne: jest.fn(async () => ({ ...mockDb.aiSettings })) },
    AiUsageLog: { create: jest.fn(async (r) => r), sum: jest.fn(async () => mockDb.spent), findAll: jest.fn(async () => []) },
    AiBriefingSettings: { findOne: jest.fn(async () => null) },
    GradingScale: { findAll: jest.fn(async () => []) },
    GradeBand: { findAll: jest.fn(async () => []) },
    GradingScaleSection: { findAll: jest.fn(async () => []) },
    Term: { findAll: jest.fn(async () => mockDb.terms.map((t) => ({ ...t }))), findOne: jest.fn(async () => mockDb.terms.find((t) => t.active) || null) },
    Class: { findOne: jest.fn(async ({ where } = {}) => mockDb.classes.find((c) => matchClass(c, where)) || null) },
    Student: { findOne: jest.fn(async ({ where }) => mockDb.students.find((s) => s.studentId === Number(where.studentId)) || null) },
    AiWatchlistEntry: {
      findAll: jest.fn(async ({ where }) => mockDb.entries.filter((e) => e.termId === where.termId && where.studentId[Op.in].includes(e.studentId)).map((e) => ({ ...e }))),
      findOne: jest.fn(async ({ where }) => {
        const e = mockDb.entries.find((x) => mockKey(x) === mockKey(where));
        return e ? { ...e } : null;
      }),
      upsert: jest.fn(async (r) => {
        const e = mockDb.entries.find((x) => mockKey(x) === mockKey(r));
        if (e) Object.assign(e, r);
        else mockDb.entries.push({ ...r });
        return [r, !e];
      }),
    },
  };
});

jest.mock("../services/atRisk/data.js", () => ({
  roster: jest.fn(),
  termMarks: jest.fn(),
  termAverages: jest.fn(),
  termAttendance: jest.fn(),
  recentRegisters: jest.fn(),
}));
jest.mock("../services/school.js", () => ({ getSchoolSettings: jest.fn(async () => ({ name: "Perfect Peace School" })) }));

const app = require("../index.js").default;
const data = require("../services/atRisk/data.js");
const { setAiProviderForTests } = require("../services/ai/client.js");
const { createFakeProvider } = require("../services/ai/providers/fake.js");
const { clearAiSettingsCache } = require("../services/ai/settings.js");
const { notesProblem } = require("../services/atRisk/service.js");
const accessStore = require("../services/accessStore.js"); // the in-memory fake (testSupport/jestSetup.js)
const { clearAccessCache } = require("../services/officeAccess.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const T = {
  admin: sign({ category: "Administrator", username: "admin", teacherId: null }),
  accountant: sign({ category: "Accountant", username: "acc", teacherId: null }),
  ct: sign({ category: "Class Teacher", username: "ct5", teacherId: 3 }), // P5
  ctNoClass: sign({ category: "Class Teacher", username: "ct9", teacherId: 9 }),
  teacher: sign({ id: 3, userRole: "STAFF" }),
  pupil: sign({ id: 7, userRole: "STU" }),
};
const get = (path, t) => request(app).get(path).set("Authorization", `Bearer ${t}`);
const post = (path, t, body = {}) => request(app).post(path).set("Authorization", `Bearer ${t}`).send(body);
const put = (path, t, body = {}) => request(app).put(path).set("Authorization", `Bearer ${t}`).send(body);

// P5 (class 5): Ama is away 4 days in a row and owes GH₵ 450; Kofi is fine.
// KG 1 (class 8): Esi at 50% attendance. JHS 1 (class 6): Yaw failing 3 subjects
// and down on last term. Contact data planted in a name to prove it is scrubbed.
const ROSTER = [
  { studentId: 1, name: "Ama Mensah", firstName: "Ama", owing: 450, classId: 5, className: "P5", section: "Primary" },
  { studentId: 2, name: "Kofi Asare", firstName: "Kofi", owing: 0, classId: 5, className: "P5", section: "Primary" },
  { studentId: 3, name: "Esi Owusu", firstName: "Esi", owing: 0, classId: 8, className: "KG 1", section: "KG" },
  { studentId: 4, name: "Yaw Boateng 0244123456", firstName: "Yaw", owing: 20, classId: 6, className: "JHS 1", section: "JHS" },
];
const stubData = () => {
  data.roster.mockImplementation(async ({ classId }) => ROSTER.filter((p) => classId === null || p.classId === classId));
  data.termMarks.mockImplementation(async ({ studentIds }) =>
    [
      ...["English", "Maths", "Science"].map((s) => ({ studentId: 2, subjectName: s, score: 70 })),
      { studentId: 4, subjectName: "English", score: 35 },
      { studentId: 4, subjectName: "Maths", score: 41 },
      { studentId: 4, subjectName: "Science", score: 44 },
      { studentId: 4, subjectName: "French", score: 70 },
    ].filter((m) => studentIds.includes(m.studentId))
  );
  data.termAverages.mockImplementation(async ({ studentIds }) => [{ studentId: 4, subjects: 4, average: 61 }, { studentId: 2, subjects: 3, average: 71 }].filter((m) => studentIds.includes(m.studentId)));
  data.termAttendance.mockImplementation(async ({ studentIds }) =>
    [
      { studentId: 1, marked: 40, present: 37 },
      { studentId: 2, marked: 40, present: 40 },
      { studentId: 3, marked: 30, present: 15 },
      { studentId: 4, marked: 40, present: 39 },
    ].filter((m) => studentIds.includes(m.studentId))
  );
  data.recentRegisters.mockImplementation(async ({ studentIds }) =>
    [
      ...["2026-11-13", "2026-11-12", "2026-11-11", "2026-11-10"].map((date) => ({ studentId: 1, date, status: "Absent" })),
      { studentId: 1, date: "2026-11-09", status: "Present" },
    ].filter((m) => studentIds.includes(m.studentId))
  );
};

let provider;
const useProvider = (script) => {
  provider = createFakeProvider(script);
  setAiProviderForTests(provider);
};
// Notes for every pupil sent, in the order sent (most at risk first).
const goodNotes = (req) => {
  const sent = JSON.parse(req.messages.at(-1).content.split("Pupils, most at risk first:\n")[1]);
  return {
    json: {
      pupils: sent.map((p) => ({
        key: p.key,
        note: `${p.firstName} is on the list: ${p.reasons[0].statement}`,
        nextStep: "The class teacher should call the family this week.",
      })),
    },
  };
};

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, AI_ENABLED: "true", GEMINI_API_KEY: "test-key" };
  mockDb.entries = [];
  mockDb.aiSettings = { aiSettingsId: 1, enabled: true, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
  mockDb.spent = 0;
  mockDb.terms = [
    { termId: 6, term: "1", startDate: "2026-01-05", endDate: "2026-04-01", active: false },
    { termId: 7, term: "2", startDate: "2026-09-08", endDate: "2026-12-18", active: true },
  ];
  mockDb.classes = [
    { classId: 5, name: "P5", section: "Primary", teacherId: 3, isDeleted: false },
    { classId: 6, name: "JHS 1", section: "JHS", teacherId: 4, isDeleted: false },
    { classId: 8, name: "KG 1", section: "KG", teacherId: 5, isDeleted: false },
    { classId: 9, name: "Old", section: "Primary", teacherId: 9, isDeleted: true },
  ];
  mockDb.students = ROSTER.map((p) => ({ studentId: p.studentId, classId: p.classId, isDeleted: false }));
  clearAiSettingsCache();
  Object.values(data).forEach((f) => f.mockReset());
  stubData();
  useProvider([goodNotes]);
});
afterAll(() => {
  setAiProviderForTests(null);
  process.env = ENV;
});

describe("who sees the watchlist", () => {
  it("Administrator: every class, most at risk first, reasons with figures", async () => {
    const res = await get("/ai/watchlist", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.term).toMatchObject({ termId: 7, label: "Term 2", active: true });
    expect(res.body.previousTerm).toMatchObject({ termId: 6, label: "Term 1" });
    expect(res.body.considered).toBe(4);
    expect(res.body.entries.map((e) => e.studentId)).toEqual([3, 4, 1]); // Kofi isn't on it
    const yaw = res.body.entries[1];
    expect(yaw.reasons.map((r) => r.kind)).toEqual(["FAILING_SUBJECTS", "SCORE_DROP"]);
    expect(yaw.reasons[1].statement).toBe("Average score fell from 61 last term (Term 1) to 47.5 this term, down 13.5 points.");
    expect(yaw).toMatchObject({ level: "HIGH", riskScore: 53, passMark: 50, note: null, status: { state: "OPEN" } });
    const ama = res.body.entries[2];
    expect(ama.reasons.map((r) => r.kind)).toEqual(["CONSECUTIVE_ABSENCES", "OWING"]);
    expect(ama.firstAction).toMatch(/Call the family/);
    expect(ama).toMatchObject({ level: "MEDIUM", riskScore: 16 });
    const esi = res.body.entries[0];
    expect(esi).toMatchObject({ isKg: true, passMark: null, level: "HIGH", riskScore: 80 });
    expect(esi.reasons.map((r) => r.kind)).toEqual(["LOW_ATTENDANCE"]);
    expect(res.body.counts).toMatchObject({ total: 3, byLevel: { HIGH: 2, MEDIUM: 1, LOW: 0 } });
    expect(res.body.ai).toEqual({ available: true, reason: null });
  });

  it("Administrator: one class and the level filter (counts stay over the scope)", async () => {
    const res = await get("/ai/watchlist?classId=5&level=LOW", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.scope).toMatchObject({ classId: 5, className: "P5" });
    expect(res.body.entries).toEqual([]);
    expect(res.body.counts.total).toBe(1);
    expect((await get("/ai/watchlist?classId=99", T.admin)).status).toBe(404);
  });

  it("Class Teacher: own class only, whatever is asked", async () => {
    const own = await get("/ai/watchlist", T.ct);
    expect(own.status).toBe(200);
    expect(own.body.scope).toEqual({ classId: 5, className: "P5", own: true });
    expect(own.body.entries.map((e) => e.studentId)).toEqual([1]);
    expect(data.roster).toHaveBeenLastCalledWith({ classId: 5 });
    expect((await get("/ai/watchlist?classId=5", T.ct)).status).toBe(200);
    const other = await get("/ai/watchlist?classId=6", T.ct);
    expect(other.status).toBe(403);
    expect(other.body.message).toMatch(/your own class/);
  });

  it("a Class Teacher login with no class, an Accountant, portal tokens and no token are refused", async () => {
    expect((await get("/ai/watchlist", T.ctNoClass)).status).toBe(403);
    expect((await get("/ai/watchlist", T.accountant)).status).toBe(403);
    expect((await get("/ai/watchlist", T.teacher)).status).toBe(403);
    expect((await get("/ai/watchlist", T.pupil)).status).toBe(403);
    expect((await request(app).get("/ai/watchlist")).status).toBe(401);
  });

  describe("custom roles (B10): ai.at_risk, with academics.all_classes for every class", () => {
    const custom = (roleId, name, permissions, teacherId) => {
      accessStore.addRole({ roleId, name, permissions });
      return sign({ category: name, username: `u${roleId}`, roleId, teacherId });
    };
    beforeEach(() => {
      accessStore.reset();
      clearAccessCache();
    });
    afterAll(() => {
      accessStore.reset();
      clearAccessCache();
    });

    it("ai.at_risk without academics.all_classes: the class linked to the login only (as the Class Teacher)", async () => {
      const t = custom(40, "Year head", ["ai.at_risk"], 3);
      const own = await get("/ai/watchlist", t);
      expect(own.status).toBe(200);
      expect(own.body.scope).toEqual({ classId: 5, className: "P5", own: true });
      expect(own.body.entries.map((e) => e.studentId)).toEqual([1]);
      expect((await get("/ai/watchlist?classId=6", t)).status).toBe(403);
      expect((await post("/ai/watchlist/notes", t, { classId: 6 })).status).toBe(403);
      expect((await put("/ai/watchlist/4/status", t, { status: "DISMISSED" })).status).toBe(403); // pupil in another class
      // no class linked to the login: refused
      expect((await get("/ai/watchlist", custom(41, "Unlinked", ["ai.at_risk"], 9))).status).toBe(403);
    });

    it("ai.at_risk with academics.all_classes: school-wide or any one class", async () => {
      const t = custom(42, "Deputy head", ["ai.at_risk", "academics.all_classes"], null);
      const all = await get("/ai/watchlist", t);
      expect(all.status).toBe(200);
      expect(all.body.entries.map((e) => e.studentId)).toEqual([3, 4, 1]);
      expect((await get("/ai/watchlist?classId=6", t)).body.scope).toMatchObject({ classId: 6 });
    });

    it("academics.all_classes without ai.at_risk: no watchlist", async () => {
      const t = custom(43, "Records", ["academics.all_classes", "results.view", "attendance.view"], null);
      expect((await get("/ai/watchlist", t)).status).toBe(403);
      expect((await post("/ai/watchlist/notes", t, {})).status).toBe(403);
    });
  });

  it("a past term: no open-term reasons (days in a row, fees), no previous term for the first", async () => {
    const res = await get("/ai/watchlist?termId=6", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.previousTerm).toBeNull();
    expect(data.recentRegisters).not.toHaveBeenCalled();
    expect(data.termAverages).not.toHaveBeenCalled();
    expect(res.body.entries.flatMap((e) => e.reasons.map((r) => r.kind))).not.toContain("OWING");
    expect((await get("/ai/watchlist?termId=55", T.admin)).status).toBe(404);
  });

  it("no open term and none asked for: 400", async () => {
    mockDb.terms = mockDb.terms.map((t) => ({ ...t, active: false }));
    expect((await get("/ai/watchlist", T.admin)).status).toBe(400);
  });
});

describe("AI off or over the cap: the list still works", () => {
  it("AI off for the school", async () => {
    mockDb.aiSettings.enabled = false;
    const res = await get("/ai/watchlist", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.ai).toEqual({ available: false, reason: "SCHOOL_OFF" });
    const notes = await post("/ai/watchlist/notes", T.admin, {});
    expect(notes.status).toBe(403);
    expect(notes.body).toMatchObject({ code: "AI_DISABLED", reason: "SCHOOL_OFF", feature: "AT_RISK" });
    expect(provider.calls).toHaveLength(0);
  });
  it("feature switched off", async () => {
    mockDb.aiSettings.featureToggles = { AT_RISK: false };
    expect((await get("/ai/watchlist", T.ct)).body.ai).toEqual({ available: false, reason: "FEATURE_OFF" });
  });
  it("over the cap: the list, and 429 on notes (amounts for the Administrator only)", async () => {
    mockDb.spent = 150;
    const res = await get("/ai/watchlist", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.ai).toEqual({ available: false, reason: "QUOTA" });
    const admin = await post("/ai/watchlist/notes", T.admin, {});
    expect(admin.status).toBe(429);
    expect(admin.body).toMatchObject({ code: "AI_QUOTA", capGhs: 100 });
    const ct = await post("/ai/watchlist/notes", T.ct, {});
    expect(ct.status).toBe(429);
    expect(ct.body.capGhs).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });
  it("is on by default once AI is on (AT_RISK is built)", async () => {
    expect((await get("/ai/status", T.ct)).body.features.AT_RISK).toMatchObject({ available: true });
  });
});

describe("AI notes", () => {
  it("writes a note per pupil, stores it with the fingerprint, and the list shows it", async () => {
    const res = await post("/ai/watchlist/notes", T.admin, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ written: 3, remaining: 0, promptVersion: "atRisk@1.0.0" });
    expect(provider.calls).toHaveLength(1);
    const list = await get("/ai/watchlist", T.admin);
    const ama = list.body.entries.find((e) => e.studentId === 1);
    expect(ama.note).toMatchObject({ text: expect.stringMatching(/^Ama is on the list: Away on the last 4/), nextStep: expect.any(String), by: "OFFICE:admin" });
    expect(list.body.counts.withNote).toBe(3);
  });

  it("cached: a second press with the same figures makes no AI call", async () => {
    await post("/ai/watchlist/notes", T.admin, {});
    const again = await post("/ai/watchlist/notes", T.admin, {});
    expect(again.body).toMatchObject({ written: 0, remaining: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("figures move -> the old note is hidden and can be written again", async () => {
    await post("/ai/watchlist/notes", T.admin, {});
    ROSTER[0].owing = 500;
    try {
      const list = await get("/ai/watchlist", T.admin);
      expect(list.body.entries.find((e) => e.studentId === 1).note).toBeNull();
      expect(list.body.entries.find((e) => e.studentId === 4).note).not.toBeNull();
    } finally {
      ROSTER[0].owing = 450;
    }
  });

  it("a note with a number that wasn't supplied is rejected (one retry, then AI_FAILED, nothing stored)", async () => {
    const invented = (req) => {
      const good = goodNotes(req).json;
      good.pupils[0].note = "Yaw has missed 14 days and is failing.";
      return { json: good };
    };
    useProvider([invented]);
    const res = await post("/ai/watchlist/notes", T.admin, {});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("AI_FAILED");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].messages.at(-1).content).toMatch(/not supplied: 14/);
    expect(mockDb.entries).toEqual([]);
    expect((await get("/ai/watchlist", T.admin)).body.entries).toHaveLength(3); // the list is unchanged
  });

  it("Class Teacher: notes for their own class only; nothing for another class", async () => {
    const res = await post("/ai/watchlist/notes", T.ct, { classId: 5 });
    expect(res.status).toBe(200);
    expect(res.body.written).toBe(1);
    expect(mockDb.entries.map((e) => e.studentId)).toEqual([1]);
    expect((await post("/ai/watchlist/notes", T.ct, { classId: 6 })).status).toBe(403);
  });

  it("only the pupils asked for, never dismissed pupils; first names only and no contact data to the AI", async () => {
    mockDb.entries.push({ studentId: 3, termId: 7, status: "DISMISSED", statusKinds: ["LOW_ATTENDANCE"] });
    const res = await post("/ai/watchlist/notes", T.admin, { studentIds: [3, 4] });
    expect(res.body.written).toBe(1);
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).toContain("Yaw");
    expect(sent).not.toContain("0244123456");
    expect(sent).not.toContain("Boateng");
    expect(sent).not.toContain("Esi");
    expect(sent).not.toContain("studentId");
  });

  it("notesProblem: unknown key, twice, too short, and the key's own number isn't a figure", () => {
    const pupils = [{ key: "P3", firstName: "Ama", reasons: [{ statement: "Away 4 days", figures: [{ label: "Days", value: 4 }] }] }];
    const ok = { key: "P3", note: "Ama was away on 4 days in a row.", nextStep: "Call the family today." };
    expect(notesProblem({ pupils: [ok] }, { pupils, termLabel: "Term 2" })).toBeNull();
    expect(notesProblem({ pupils: [{ ...ok, note: "Ama was away on 2 days and in Term 2." }] }, { pupils, termLabel: "Term 2" })).toBeNull();
    expect(notesProblem({ pupils: [{ ...ok, key: "P9" }] }, { pupils, termLabel: "Term 2" })).toMatch(/not sent/);
    expect(notesProblem({ pupils: [ok, ok] }, { pupils, termLabel: "Term 2" })).toMatch(/twice/);
    expect(notesProblem({ pupils: [{ ...ok, note: "Short." }] }, { pupils, termLabel: "Term 2" })).toMatch(/20 to 400/);
    expect(notesProblem({ pupils: [{ ...ok, note: "Ama was away on 3 days in a row." }] }, { pupils, termLabel: "Term 1" })).toMatch(/not supplied: 3/);
    expect(notesProblem({ pupils: [] }, { pupils, termLabel: "Term 2" })).toMatch(/each pupil/);
  });
});

describe("being handled / dismissed", () => {
  it("marks with who and when; dismissed is hidden by default and listed with status=ALL", async () => {
    const res = await put("/ai/watchlist/1/status", T.ct, { status: "HANDLING", note: "Called mum on Monday" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ onWatchlist: true, status: { state: "HANDLING", note: "Called mum on Monday", by: "OFFICE:ct5" } });
    expect(res.body.status.at).toEqual(expect.any(String));

    await put("/ai/watchlist/3/status", T.admin, { status: "DISMISSED" });
    const list = await get("/ai/watchlist", T.admin);
    expect(list.body.entries.map((e) => e.studentId)).toEqual([4, 1]); // Esi dismissed
    expect(list.body.counts.byStatus).toEqual({ OPEN: 1, HANDLING: 1, DISMISSED: 1 });
    expect((await get("/ai/watchlist?status=ALL", T.admin)).body.entries).toHaveLength(3);
    expect((await get("/ai/watchlist?status=DISMISSED", T.admin)).body.entries.map((e) => e.studentId)).toEqual([3]);

    const reopened = await put("/ai/watchlist/3/status", T.admin, { status: "OPEN" });
    expect(reopened.body.status).toMatchObject({ state: "OPEN", note: null, by: "OFFICE:admin" });
  });

  it("a dismissed pupil comes back when a NEW reason appears", async () => {
    await put("/ai/watchlist/3/status", T.admin, { status: "DISMISSED" });
    ROSTER[2].owing = 300;
    try {
      const e = (await get("/ai/watchlist", T.admin)).body.entries.find((x) => x.studentId === 3);
      expect(e.status).toMatchObject({ state: "OPEN", reopened: true, newKinds: ["OWING"], setTo: "DISMISSED" });
    } finally {
      ROSTER[2].owing = 0;
    }
  });

  it("keeps the AI note when the status changes (and the status when a note is written)", async () => {
    await post("/ai/watchlist/notes", T.admin, {});
    await put("/ai/watchlist/1/status", T.admin, { status: "HANDLING" });
    const e = (await get("/ai/watchlist", T.admin)).body.entries.find((x) => x.studentId === 1);
    expect(e.note).not.toBeNull();
    expect(e.status.state).toBe("HANDLING");
  });

  it("Class Teacher: own class pupils only; bad input refused", async () => {
    expect((await put("/ai/watchlist/4/status", T.ct, { status: "DISMISSED" })).status).toBe(403);
    expect((await put("/ai/watchlist/1/status", T.ct, { status: "MAYBE" })).status).toBe(400);
    expect((await put("/ai/watchlist/1/status", T.ct, { status: "HANDLING", note: "x".repeat(301) })).status).toBe(400);
    expect((await put("/ai/watchlist/77/status", T.admin, { status: "HANDLING" })).status).toBe(404);
    expect((await put("/ai/watchlist/1/status", T.accountant, { status: "HANDLING" })).status).toBe(403);
    expect(mockDb.entries).toEqual([]);
  });

  it("before migration 049: the list still loads, with no marks or notes", async () => {
    const M = require("../models/index.js");
    M.AiWatchlistEntry.findAll.mockRejectedValueOnce(Object.assign(new Error("relation does not exist"), { original: { code: "42P01" } }));
    const res = await get("/ai/watchlist", T.admin);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
  });

  it("works with AI switched off", async () => {
    mockDb.aiSettings.enabled = false;
    expect((await put("/ai/watchlist/1/status", T.admin, { status: "DISMISSED" })).status).toBe(200);
  });
});
