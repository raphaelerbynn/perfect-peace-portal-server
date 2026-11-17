// AI-0: who reaches the AI endpoints, and requireAiFeature gating per feature
// and role, with AI off / on / over the cap (models mocked, no DB, no network).
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";
import express from "express";

const mockDb = { settings: null, spent: 0 };
jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  return {
    __esModule: true,
    ...actual,
    AiSettings: {
      findOne: jest.fn(async () => ({ ...mockDb.settings })),
      update: jest.fn(async (patch) => {
        Object.assign(mockDb.settings, patch);
        return [1];
      }),
    },
    AiUsageLog: {
      create: jest.fn(async (r) => r),
      sum: jest.fn(async () => mockDb.spent),
      findAll: jest.fn(async () => []),
    },
    AiSuggestion: {
      findOne: jest.fn(async () => null),
      findAll: jest.fn(async () => []),
      findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
      update: jest.fn(),
      create: jest.fn(),
    },
  };
});
jest.mock("../config/database.js", () => {
  const actual = jest.requireActual("../config/database.js");
  actual.default.transaction = jest.fn(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }));
  return actual;
});

const app = require("../index.js").default;
const { requireAiFeature } = require("../services/ai/gate.js");
const { clearAiSettingsCache } = require("../services/ai/settings.js");
const { staffToken } = require("../routes/teacherRoutes.js");
const { errorHandler } = require("../utils/errorHandling.js");
const accessStore = require("../services/accessStore.js"); // the in-memory fake (testSupport/jestSetup.js)
const { clearAccessCache } = require("../services/officeAccess.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const T = {
  admin: sign({ category: "Administrator", username: "admin", teacherId: null }),
  accountant: sign({ category: "Accountant", username: "acc", teacherId: null }),
  classTeacher: sign({ category: "Class Teacher", username: "ct", teacherId: 3 }),
  teacher: sign({ id: 3, userRole: "STAFF" }),
  pupil: sign({ id: 7, userRole: "STU" }),
};
// B10 custom roles (made in each test that uses them, with addCustomRoles()).
const CUSTOM = {
  askFees: { roleId: 30, name: "Bursar's clerk", permissions: ["ai.ask", "fees.view"] },
  askSettings: { roleId: 31, name: "AI lead", permissions: ["ai.ask", "ai.settings"] },
  atRiskOwn: { roleId: 32, name: "Year head", permissions: ["ai.at_risk"] },
  nothingAi: { roleId: 33, name: "Fees only", permissions: ["fees.view", "accounting.view", "academics.all_classes"] },
};
const addCustomRoles = () => {
  accessStore.reset();
  clearAccessCache();
  for (const r of Object.values(CUSTOM)) accessStore.addRole(r);
};
const customToken = (key) => sign({ category: CUSTOM[key].name, username: `u-${key}`, roleId: CUSTOM[key].roleId, teacherId: 3 });
const auth = (r, t) => (t ? r.set("Authorization", `Bearer ${t}`) : r);

const ENV = { ...process.env };
const on = () => {
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key";
  mockDb.settings.enabled = true;
};
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.AI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  mockDb.settings = { aiSettingsId: 1, enabled: false, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
  mockDb.spent = 0;
  clearAiSettingsCache();
  accessStore.reset();
  clearAccessCache();
});
afterAll(() => {
  process.env = ENV;
});

// A feature route the way AI-1/3/5/8 will write one.
const featureApp = () => {
  const a = express();
  a.use(express.json());
  for (const f of ["ASK", "PAPERS", "BRIEFING", "ANNOUNCEMENTS", "AT_RISK", "REMARKS"]) {
    a.post(`/f/${f}`, requireAiFeature(f), (req, res) => res.json({ ok: true, actor: req.aiActor }));
  }
  a.get("/f/PAPERS-list", requireAiFeature("PAPERS", { budget: false }), (req, res) => res.json({ ok: true }));
  // inside a teacherRouter-style chain (req.user already set by staffToken)
  a.post("/teacher/papers", staffToken, requireAiFeature("PAPERS"), (req, res) => res.json({ ok: true }));
  a.use(errorHandler);
  return a;
};

describe("requireAiFeature: roles (AI on)", () => {
  const fa = featureApp();
  // B10: the system roles' AI permissions reproduce the AI branch's role table.
  const ROLE_TABLE = [
    // feature,        admin, accountant, classTeacher, teacher(portal), pupil
    ["ASK", 200, 200, 403, 403, 403],
    ["PAPERS", 200, 403, 403, 200, 403],
    ["BRIEFING", 200, 403, 403, 403, 403],
    ["ANNOUNCEMENTS", 200, 403, 403, 403, 403],
    ["AT_RISK", 200, 403, 200, 403, 403],
  ];
  it.each(ROLE_TABLE)("%s", async (feature, ...expected) => {
    on();
    const who = ["admin", "accountant", "classTeacher", "teacher", "pupil"];
    for (let i = 0; i < who.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await auth(request(fa).post(`/f/${feature}`), T[who[i]]);
      expect([who[i], res.status]).toEqual([who[i], expected[i]]);
    }
  });

  it("no token = 401; the actor is set for the feature", async () => {
    on();
    expect((await request(fa).post("/f/ASK")).status).toBe(401);
    expect((await auth(request(fa).post("/f/PAPERS"), T.teacher)).body.actor).toBe("STAFF:3");
    expect((await auth(request(fa).post("/f/ASK"), T.accountant)).body.actor).toBe("OFFICE:acc");
  });

  it("works after the teacher router's staffToken", async () => {
    on();
    expect((await auth(request(fa).post("/teacher/papers"), T.teacher)).status).toBe(200);
    expect((await auth(request(fa).post("/teacher/papers"), T.admin)).status).toBe(403); // staffToken: portal only
  });

  it("an unknown feature key fails when the route is defined", () => {
    expect(() => requireAiFeature("NOPE")).toThrow(/Unknown AI feature/);
  });

  it("custom roles (B10): the feature's permission decides, never the role's name", async () => {
    on();
    addCustomRoles();
    const expectStatus = async (feature, key, status) => {
      const res = await auth(request(fa).post(`/f/${feature}`), customToken(key));
      expect([feature, key, res.status]).toEqual([feature, key, status]);
    };
    await expectStatus("ASK", "askFees", 200);
    await expectStatus("BRIEFING", "askFees", 403);
    await expectStatus("AT_RISK", "atRiskOwn", 200);
    await expectStatus("ASK", "atRiskOwn", 403);
    for (const f of ["ASK", "PAPERS", "BRIEFING", "ANNOUNCEMENTS", "AT_RISK", "REMARKS"]) await expectStatus(f, "nothingAi", 403);
    // the parked features follow ai.settings
    await expectStatus("REMARKS", "askSettings", 403); // switched off by default, but past the permission check:
    const reason = (await auth(request(fa).post("/f/REMARKS"), customToken("askSettings"))).body.reason;
    expect(reason).toBe("FEATURE_OFF");
    // a token naming the Administrator category but carrying a custom roleId gets the custom role
    const forged = sign({ category: "Administrator", username: "u-askFees", roleId: CUSTOM.askFees.roleId });
    expect((await auth(request(fa).post("/f/BRIEFING"), forged)).status).toBe(403);
  });
});

describe("requireAiFeature: switches and budget", () => {
  const fa = featureApp();
  const call = (path = "/f/ANNOUNCEMENTS", t = T.admin) => auth(request(fa).post(path), t);

  it.each([
    ["server off (default)", () => {}, "SERVER_OFF"],
    ["no key", () => { process.env.AI_ENABLED = "true"; }, "NO_KEY"],
    ["school off", () => { on(); mockDb.settings.enabled = false; }, "SCHOOL_OFF"],
    ["feature off", () => { on(); mockDb.settings.featureToggles = { ANNOUNCEMENTS: false }; }, "FEATURE_OFF"],
  ])("%s -> 403 AI_DISABLED", async (_l, setup, reason) => {
    setup();
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AI_DISABLED", reason, feature: "ANNOUNCEMENTS" });
    expect(res.body.message).toMatch(/by hand/);
  });

  it("later features start switched off", async () => {
    on();
    expect((await call("/f/REMARKS")).body).toMatchObject({ code: "AI_DISABLED", reason: "FEATURE_OFF" });
  });

  it("role is checked before the switches (no settings leak to other roles)", async () => {
    const res = await call("/f/BRIEFING", T.accountant);
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
  });

  it("at the cap -> 429 AI_QUOTA with the amounts; reads can skip the budget check", async () => {
    on();
    mockDb.spent = 100;
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "AI_QUOTA", spentGhs: 100, capGhs: 100 });
    expect(res.body.message).toMatch(/GH₵ 100\.00 of GH₵ 100\.00/);
    expect((await auth(request(fa).get("/f/PAPERS-list"), T.teacher)).status).toBe(200);
    // Anyone but an Administrator: the plain message, no amounts anywhere.
    for (const [path, t] of [["/f/PAPERS", T.teacher], ["/f/ASK", T.accountant], ["/teacher/papers", T.teacher]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(path, t);
      expect(r.status).toBe(429);
      expect(r.body).toEqual({ code: "AI_QUOTA", message: "This month's AI budget is used up; carry on by hand." });
    }
  });
});

describe("error envelope", () => {
  it("a provider failure reaches the page as a readable 503 with code + errorClass; other 5xx stay masked", async () => {
    const { toUserError, AiProviderError } = require("../services/ai/errors.js");
    const { AppError } = require("../utils/errorHandling.js");
    const a = express();
    a.get("/busy", (req, res, next) => next(toUserError(new AiProviderError("RATE_LIMIT", "429 from google"))));
    a.get("/plain", (req, res, next) => next(new AppError("db exploded", 500)));
    a.use(errorHandler);
    const busy = await request(a).get("/busy");
    expect(busy.status).toBe(503);
    expect(busy.body).toEqual({ message: expect.stringMatching(/busy/), code: "AI_FAILED", errorClass: "RATE_LIMIT" });
    expect(JSON.stringify(busy.body)).not.toMatch(/google/);
    expect((await request(a).get("/plain")).body).toEqual({ message: "Something went wrong. Please try again later." });
  });
});

describe("/ai/* routes", () => {
  it.each([
    ["get", "/ai/settings"],
    ["put", "/ai/settings"],
    ["get", "/ai/usage"],
    ["get", "/ai/suggestions"],
    ["get", "/ai/suggestions/1"],
    ["patch", "/ai/suggestions/1"],
    ["post", "/ai/suggestions/1/accept"],
    ["post", "/ai/suggestions/1/reject"],
  ])("%s %s: Administrator only (ai.settings / ai.suggestions.review)", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
    for (const t of [T.accountant, T.classTeacher, T.teacher, T.pupil]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await auth(request(app)[method](path), t)).status).toBe(403);
    }
    const res = await auth(request(app)[method](path), T.admin);
    expect([401, 403]).not.toContain(res.status);
  });

  it("GET /ai/settings shows the server state without the key", async () => {
    process.env.AI_ENABLED = "true";
    process.env.GEMINI_API_KEY = "secret-key-123";
    const res = await auth(request(app).get("/ai/settings"), T.admin);
    expect(res.status).toBe(200);
    expect(res.body.server).toMatchObject({ ready: true, hasKey: true, envEnabled: true });
    expect(JSON.stringify(res.body)).not.toContain("secret-key-123");
    expect(res.body.features).toHaveLength(8);
  });

  it("GET /ai/settings: each feature's \"For:\" comes from the built-in roles holding its permission (B10)", async () => {
    const res = await auth(request(app).get("/ai/settings"), T.admin);
    const by = Object.fromEntries(res.body.features.map((f) => [f.key, f]));
    expect(by.ASK).toMatchObject({ permission: "ai.ask", roles: ["Administrator", "Accountant"] });
    expect(by.PAPERS).toMatchObject({ permission: "ai.papers.view_all", roles: ["Administrator", "Teachers (portal)"] });
    expect(by.BRIEFING).toMatchObject({ permission: "ai.briefing", roles: ["Administrator"] });
    expect(by.ANNOUNCEMENTS).toMatchObject({ permission: "ai.announcements", roles: ["Administrator"] });
    expect(by.AT_RISK).toMatchObject({ permission: "ai.at_risk", roles: ["Administrator", "Class Teacher"] });
    expect(by.REMARKS).toMatchObject({ permission: "ai.settings", roles: ["Administrator"] });
    for (const f of res.body.features) expect(f.permissionLabel).toEqual(expect.any(String));
  });

  it("PUT /ai/settings: switching on while the server is off is a 400 the page can show", async () => {
    const res = await auth(request(app).put("/ai/settings").send({ enabled: true }), T.admin);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/switched off on the server/);
  });

  it("GET /ai/status: each caller sees only their features; amounts only for the Administrator", async () => {
    on();
    const teacher = await auth(request(app).get("/ai/status"), T.teacher);
    expect(Object.keys(teacher.body.features)).toEqual(["PAPERS"]);
    expect(teacher.body.features.PAPERS).toMatchObject({ available: true, reason: null });
    expect(teacher.body.budget).toBeUndefined();
    const acc = await auth(request(app).get("/ai/status"), T.accountant);
    expect(Object.keys(acc.body.features)).toEqual(["ASK"]);
    const pupil = await auth(request(app).get("/ai/status"), T.pupil);
    expect(pupil.body.features).toEqual({});
    const admin = await auth(request(app).get("/ai/status"), T.admin);
    expect(admin.body.budget).toMatchObject({ capGhs: 100 });
    expect(admin.body.features.REMARKS).toMatchObject({ available: false, reason: "FEATURE_OFF" });
    mockDb.spent = 200;
    const over = await auth(request(app).get("/ai/status"), T.teacher);
    expect(over.body.features.PAPERS).toMatchObject({ available: false, reason: "QUOTA" });
    expect((await request(app).get("/ai/status")).status).toBe(401);
  });

  it("budget amounts follow ai.settings (B10): a custom role with ai.ask sees none; with ai.settings it sees them", async () => {
    on();
    addCustomRoles();
    const plain = await auth(request(app).get("/ai/status"), customToken("askFees"));
    expect(Object.keys(plain.body.features)).toEqual(["ASK"]);
    expect(plain.body.budget).toBeUndefined();
    const lead = await auth(request(app).get("/ai/status"), customToken("askSettings"));
    expect(lead.body.budget).toMatchObject({ capGhs: 100 });
    // ...and the 429 at the cap
    mockDb.spent = 100;
    const fa = featureApp();
    const noAmounts = await auth(request(fa).post("/f/ASK"), customToken("askFees"));
    expect(noAmounts.status).toBe(429);
    expect(noAmounts.body).toEqual({ code: "AI_QUOTA", message: "This month's AI budget is used up; carry on by hand." });
    const amounts = await auth(request(fa).post("/f/ASK"), customToken("askSettings"));
    expect(amounts.status).toBe(429);
    expect(amounts.body).toMatchObject({ code: "AI_QUOTA", spentGhs: 100, capGhs: 100 });
    // the Class Teacher (watchlist) gets no amounts either
    expect((await auth(request(fa).post("/f/AT_RISK"), T.classTeacher)).body).toEqual({ code: "AI_QUOTA", message: "This month's AI budget is used up; carry on by hand." });
  });

  it("settings and usage need ai.settings; Ask alone does not open them", async () => {
    addCustomRoles();
    expect((await auth(request(app).get("/ai/usage"), customToken("askFees"))).status).toBe(403);
    expect((await auth(request(app).get("/ai/settings"), customToken("askFees"))).status).toBe(403);
    expect((await auth(request(app).get("/ai/usage"), customToken("askSettings"))).status).toBe(200);
    expect((await auth(request(app).get("/ai/suggestions"), customToken("askSettings"))).status).toBe(403); // drafts: ai.suggestions.review
  });

  it("reviewing drafts works with AI switched off (404 for a missing one, not 403)", async () => {
    const res = await auth(request(app).post("/ai/suggestions/5/accept"), T.admin);
    expect(res.status).toBe(404);
  });
});
