// AI-5: who reaches /ai/briefings*, Run now gating (Administrator + BRIEFING
// on, not the budget), and the settings validation. Models mocked, no DB.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

const mockDb = { settings: null, aiSettings: null, spent: 0 };
jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  return {
    __esModule: true,
    ...actual,
    AiSettings: { findOne: jest.fn(async () => ({ ...mockDb.aiSettings })) },
    AiUsageLog: { create: jest.fn(async (r) => r), sum: jest.fn(async () => mockDb.spent), findAll: jest.fn(async () => []) },
    AiBriefing: {
      findOne: jest.fn(async () => null),
      findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
    },
    AiBriefingSettings: {
      findOne: jest.fn(async () => mockDb.settings && { ...mockDb.settings }),
      upsert: jest.fn(async (r) => {
        mockDb.settings = { ...r };
      }),
    },
  };
});
jest.mock("../services/briefing/service.js", () => {
  const actual = jest.requireActual("../services/briefing/service.js");
  return { __esModule: true, ...actual, runBriefing: jest.fn(async () => ({ briefingId: 1, status: "QUIET" })) };
});

const app = require("../index.js").default;
const { runBriefing } = require("../services/briefing/service.js");
const { clearAiSettingsCache } = require("../services/ai/settings.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const T = {
  admin: sign({ category: "Administrator", username: "admin", teacherId: null }),
  accountant: sign({ category: "Accountant", username: "acc", teacherId: null }),
  classTeacher: sign({ category: "Class Teacher", username: "ct", teacherId: 3 }),
  teacher: sign({ id: 3, userRole: "STAFF" }),
  pupil: sign({ id: 7, userRole: "STU" }),
};
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV, AI_ENABLED: "true", GEMINI_API_KEY: "test-key" };
  mockDb.settings = { briefingSettingsId: 1, days: [1], runTime: "06:00", owingThresholdGhs: "100.00", emailEnabled: false, emailTo: null, whatsappEnabled: false, whatsappTo: null };
  mockDb.aiSettings = { aiSettingsId: 1, enabled: true, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
  mockDb.spent = 0;
  clearAiSettingsCache();
});
afterAll(() => {
  process.env = ENV;
});

describe("Run now permissions", () => {
  it("Administrator with the feature on: 200, run as MANUAL by that user", async () => {
    const res = await auth(request(app).post("/ai/briefings/run"), T.admin);
    expect(res.status).toBe(200);
    expect(runBriefing).toHaveBeenCalledWith({ trigger: "MANUAL", user: expect.objectContaining({ username: "admin" }) });
  });
  it.each([
    ["accountant", 403],
    ["classTeacher", 403],
    ["teacher", 403],
    ["pupil", 403],
    [null, 401],
  ])("%s -> %i, nothing run", async (who, status) => {
    const res = await auth(request(app).post("/ai/briefings/run"), who && T[who]);
    expect(res.status).toBe(status);
    expect(runBriefing).not.toHaveBeenCalled();
  });
  it("feature switched off: 403 AI_DISABLED", async () => {
    mockDb.aiSettings.featureToggles = { BRIEFING: false };
    const res = await auth(request(app).post("/ai/briefings/run"), T.admin);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AI_DISABLED", reason: "FEATURE_OFF" });
    expect(runBriefing).not.toHaveBeenCalled();
  });
  it("AI off on the server: 403 SERVER_OFF", async () => {
    delete process.env.AI_ENABLED;
    const res = await auth(request(app).post("/ai/briefings/run"), T.admin);
    expect(res.body).toMatchObject({ code: "AI_DISABLED", reason: "SERVER_OFF" });
  });
  it("over the budget still runs (the plain briefing)", async () => {
    mockDb.spent = 500;
    const res = await auth(request(app).post("/ai/briefings/run"), T.admin);
    expect(res.status).toBe(200);
    expect(runBriefing).toHaveBeenCalled();
  });
});

describe("reads", () => {
  it("history, latest and settings: Administrator only, and readable with AI off", async () => {
    delete process.env.AI_ENABLED;
    for (const path of ["/ai/briefings", "/ai/briefings/latest", "/ai/briefings/settings"]) {
      expect((await auth(request(app).get(path), T.admin)).status).toBe(200);
      expect((await auth(request(app).get(path), T.accountant)).status).toBe(403);
      expect((await auth(request(app).get(path), T.teacher)).status).toBe(403);
    }
    const latest = await auth(request(app).get("/ai/briefings/latest"), T.admin);
    expect(latest.body).toMatchObject({ briefing: null, running: false, available: false, reason: "SERVER_OFF", schedule: "Mondays at 06:00" });
  });
  it("an unknown briefing is a 404", async () => {
    expect((await auth(request(app).get("/ai/briefings/12"), T.admin)).status).toBe(404);
  });
});

describe("settings", () => {
  const put = (body, token = T.admin) => auth(request(app).put("/ai/briefings/settings").send(body), token);

  it("saves days, time, owing line and both channels, normalising the number", async () => {
    const res = await put({ days: [4, 1], runTime: "07:15", owingThresholdGhs: 250, emailEnabled: true, emailTo: "head@example.com", whatsappEnabled: true, whatsappTo: "024 123 4567" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      days: [1, 4],
      runTime: "07:15",
      owingThresholdGhs: 250,
      emailEnabled: true,
      whatsappEnabled: true,
      whatsappTo: "233241234567",
      schedule: "Mondays and Thursdays at 07:15",
      timeZone: "Africa/Accra",
      channels: { email: { driver: "log" }, whatsapp: { driver: "log", to: "+233241234567" } },
    });
    expect(mockDb.settings.updatedBy).toBe("admin");
  });
  it.each([
    [{ runTime: "6am" }, /HH:MM/],
    [{ runTime: "24:00" }, /HH:MM/],
    [{ days: [0] }, /weekdays/],
    [{ days: "1" }, /weekdays/],
    [{ owingThresholdGhs: 0 }, /at least 1/],
    [{ owingThresholdGhs: "abc" }, /at least 1/],
    [{ emailTo: "not-an-email" }, /email address/],
    [{ whatsappTo: "12345" }, /WhatsApp number/],
    [{ emailEnabled: true }, /Enter the head teacher's email/],
    [{ whatsappEnabled: true }, /Enter the head teacher's WhatsApp/],
    [{ emailEnabled: "yes" }, /on or off/],
  ])("refuses %j", async (body, msg) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msg);
  });
  it("clearing the address switches that channel off", async () => {
    mockDb.settings = { ...mockDb.settings, emailEnabled: true, emailTo: "head@example.com" };
    const res = await put({ emailTo: "" });
    expect(res.body).toMatchObject({ emailEnabled: false, emailTo: null });
  });
  it("either, both or neither channel", async () => {
    expect((await put({ emailTo: "head@example.com", emailEnabled: true, whatsappEnabled: false })).body).toMatchObject({ emailEnabled: true, whatsappEnabled: false });
    expect((await put({ whatsappTo: "+44 7700 900123", whatsappEnabled: true, emailEnabled: false })).body).toMatchObject({ emailEnabled: false, whatsappEnabled: true, whatsappTo: "447700900123" });
    expect((await put({ emailEnabled: false, whatsappEnabled: false })).body).toMatchObject({ emailEnabled: false, whatsappEnabled: false });
  });
  it("no days is allowed (Run now only)", async () => {
    const res = await put({ days: [] });
    expect(res.body).toMatchObject({ days: [], schedule: expect.stringMatching(/Run now only/), nextRunAt: null });
  });
  it("only the Administrator may change them", async () => {
    expect((await put({ runTime: "07:00" }, T.accountant)).status).toBe(403);
    expect((await put({ runTime: "07:00" }, T.classTeacher)).status).toBe(403);
  });
});
