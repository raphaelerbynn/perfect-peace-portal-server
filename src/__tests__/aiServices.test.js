// AI-0 (models mocked, no DB, no network): settings, cost, the budget guard
jest.mock("../config/auth.js", () => ({ __esModule: true, JWT_SECRET: "test-secret", JWT_ALGORITHM: "HS256" }));
// (under / at / over the cap), the metered run (switches, budget, redaction,
// usage rows for OK / ERROR / BLOCKED), the tool loop, and the suggestion
// state machine with accept-handler dispatch.
const mockDb = { settings: null, usage: [], suggestions: [], nextId: 1 };

jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } })) },
}));

jest.mock("../models/index.js", () => {
  const { Op } = jest.requireActual("sequelize");
  const inRange = (row, where) => {
    const c = where?.createdAt;
    if (!c) return true;
    return row.createdAt >= c[Op.gte] && row.createdAt < c[Op.lt];
  };
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
  return {
    __esModule: true,
    AiSettings: {
      findOne: jest.fn(async () => (mockDb.settings ? { ...mockDb.settings } : null)),
      update: jest.fn(async (patch) => {
        mockDb.settings = { ...mockDb.settings, ...patch };
        return [1];
      }),
    },
    AiUsageLog: {
      create: jest.fn(async (row) => {
        mockDb.usage.push(row);
        return row;
      }),
      sum: jest.fn(async (field, { where }) => mockDb.usage.filter((r) => inRange(r, where)).reduce((t, r) => t + Number(r[field]), 0)),
      findAll: jest.fn(async ({ group, where }) => {
        if (!group) return mockDb.usage.filter((r) => r.status !== "OK").map((r, i) => ({ usageId: i + 1, ...r }));
        const out = new Map();
        for (const r of mockDb.usage.filter((x) => inRange(x, where))) {
          const k = `${r.feature}|${r.status}`;
          const g = out.get(k) || { feature: r.feature, status: r.status, calls: "0", costGhs: 0 };
          g.calls = String(Number(g.calls) + 1);
          g.costGhs += r.costGhs;
          out.set(k, g);
        }
        return [...out.values()];
      }),
    },
    AiSuggestion: {
      create: jest.fn(async (row) => {
        const r = { suggestionId: mockDb.nextId++, ...row };
        mockDb.suggestions.push(r);
        return { get: () => ({ ...r }) };
      }),
      findOne: jest.fn(async ({ where }) => {
        const r = mockDb.suggestions.find((s) => matches(s, where));
        return r ? { ...r } : null;
      }),
      findAll: jest.fn(async ({ where }) => mockDb.suggestions.filter((s) => matches(s, where))),
      findAndCountAll: jest.fn(async ({ where }) => {
        const rows = mockDb.suggestions.filter((s) => matches(s, where));
        return { rows, count: rows.length };
      }),
      update: jest.fn(async (patch, { where }) => {
        const r = mockDb.suggestions.find((s) => s.suggestionId === where.suggestionId);
        Object.assign(r, patch);
        return [1];
      }),
    },
  };
});

import * as M from "../models/index.js";
import { clearAiSettingsCache, getAiSettings, getAiSettingsForAdmin, updateAiSettings } from "../services/ai/settings.js";
import { assertWithinBudget, budgetState, costOf, usageSummary } from "../services/ai/usage.js";
import { runJson, runText, runToolLoop, streamText } from "../services/ai/run.js";
import { setAiProviderForTests } from "../services/ai/client.js";
import { createFakeProvider } from "../services/ai/providers/fake.js";
import {
  acceptSuggestion,
  createSuggestion,
  editSuggestion,
  listSuggestions,
  registerAcceptHandler,
  rejectSuggestion,
  resetAcceptHandlers,
} from "../services/ai/suggestions.js";

const ENV = { ...process.env };
const turnOn = () => {
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  mockDb.settings = { aiSettingsId: 1, enabled: true, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
};

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.AI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_MONTHLY_BUDGET_GHS;
  delete process.env.AI_USD_TO_GHS;
  delete process.env.AI_FAKE_PROVIDER;
  mockDb.settings = { aiSettingsId: 1, enabled: false, featureToggles: {}, monthlyCapGhs: null, tone: {} };
  mockDb.usage = [];
  mockDb.suggestions = [];
  mockDb.nextId = 1;
  clearAiSettingsCache();
  resetAcceptHandlers();
  setAiProviderForTests(null);
});
afterAll(() => {
  process.env = ENV;
  setAiProviderForTests(null);
});

const spend = (costGhs, feature = "ASK", status = "OK", createdAt = new Date()) =>
  mockDb.usage.push({ feature, status, costGhs, createdAt, model: "m" });

describe("settings", () => {
  it("a fresh database is off, with the documented defaults", async () => {
    const s = await getAiSettings();
    expect(s).toMatchObject({ enabled: false, monthlyCapGhs: 200, capFromEnv: true, tone: { formal: true, salutation: "Dear Parent/Guardian", britishSpelling: true } });
    expect(s.featureToggles).toEqual({ ASK: true, PAPERS: true, BRIEFING: true, ANNOUNCEMENTS: true, REMARKS: false, AT_RISK: false, EXPLAIN: false, DOCUMENTS: false });
  });

  it("no table yet (migration 043 not applied) = off, not a 500", async () => {
    M.AiSettings.findOne.mockRejectedValueOnce(Object.assign(new Error("x"), { original: { code: "42P01" } }));
    expect((await getAiSettings()).enabled).toBe(false);
  });

  it("the admin view says why the server can't send", async () => {
    let v = await getAiSettingsForAdmin();
    expect(v.server).toMatchObject({ ready: false, blockReason: "SERVER_OFF", hasKey: false });
    process.env.AI_ENABLED = "true";
    v = await getAiSettingsForAdmin();
    expect(v.server.blockReason).toBe("NO_KEY");
    process.env.GEMINI_API_KEY = "k";
    v = await getAiSettingsForAdmin();
    expect(v.server).toMatchObject({ ready: true, blockReason: null, hasKey: true, model: "gemini-3.1-flash-lite" });
    expect(JSON.stringify(v)).not.toContain('"k"'); // the key itself is never returned
    expect(v.features.find((f) => f.key === "PAPERS").roles).toEqual(["Administrator", "Teachers (portal)"]);
  });

  it("refuses to switch on while the server is off or has no key", async () => {
    await expect(updateAiSettings({ enabled: true })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/AI_ENABLED/) });
    process.env.AI_ENABLED = "true";
    await expect(updateAiSettings({ enabled: true })).rejects.toMatchObject({ message: expect.stringMatching(/GEMINI_API_KEY/) });
    process.env.GEMINI_API_KEY = "k";
    const v = await updateAiSettings({ enabled: true }, { username: "admin" });
    expect(v.enabled).toBe(true);
    expect(mockDb.settings.updatedBy).toBe("admin");
  });

  it("saves toggles, cap and tone; validates each", async () => {
    const v = await updateAiSettings({ featureToggles: { ASK: false }, monthlyCapGhs: "250.555", tone: { formal: false, salutation: "  Dear Parents " } });
    expect(v.featureToggles.ASK).toBe(false);
    expect(v.featureToggles.PAPERS).toBe(true);
    expect(mockDb.settings.monthlyCapGhs).toBe(250.56);
    expect(mockDb.settings.tone).toEqual({ formal: false, salutation: "Dear Parents", britishSpelling: true });
    await updateAiSettings({ monthlyCapGhs: null });
    expect((await getAiSettings()).capFromEnv).toBe(true);
    for (const body of [{ featureToggles: { NOPE: true } }, { featureToggles: { ASK: "yes" } }, { monthlyCapGhs: -1 }, { monthlyCapGhs: "abc" }, { tone: { salutation: "x".repeat(81) } }, { enabled: "on" }, {}]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(updateAiSettings(body)).rejects.toMatchObject({ statusCode: 400 });
    }
  });
});

describe("cost and the budget guard", () => {
  it("cost is per model from token counts, converted at AI_USD_TO_GHS", () => {
    process.env.AI_USD_TO_GHS = "10";
    // flash-lite: 0.25 in, 0.025 cached, 1.5 out per M tokens
    expect(costOf({ model: "gemini-3.1-flash-lite", inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000 })).toEqual({ costMicros: 1_750_000, costGhs: 17.5 });
    expect(costOf({ model: "gemini-3.1-flash-lite-001", inputTokens: 0, cachedTokens: 1_000_000, outputTokens: 0 }).costMicros).toBe(25_000);
    // unknown model: priced at the dearest row (never under-counted)
    expect(costOf({ model: "gemini-9-ultra", inputTokens: 0, outputTokens: 1_000_000 }).costMicros).toBe(10_000_000);
    expect(costOf(null)).toEqual({ costMicros: 0, costGhs: 0 });
  });

  it.each([
    ["under", 99.99, false],
    ["at", 100, true],
    ["over", 120, true],
  ])("%s the cap", async (_l, spent, blocked) => {
    turnOn();
    spend(spent);
    spend(500, "ASK", "OK", new Date(Date.UTC(2000, 0, 15))); // an old month does not count
    const state = await budgetState();
    expect(state).toMatchObject({ spentGhs: spent, capGhs: 100, overCap: blocked });
    if (blocked) {
      await expect(assertWithinBudget({ feature: "ASK", user: { category: "Administrator", username: "admin" } })).rejects.toMatchObject({ statusCode: 429, code: "AI_QUOTA" });
      expect(mockDb.usage.at(-1)).toMatchObject({ status: "BLOCKED", errorClass: "QUOTA", userRef: "OFFICE:admin", costGhs: 0 });
    } else {
      await expect(assertWithinBudget({ feature: "ASK" })).resolves.toMatchObject({ remainingGhs: 0.01 });
    }
  });

  it("a cap of 0 blocks everything; with no cap set the env budget applies", async () => {
    turnOn();
    mockDb.settings.monthlyCapGhs = 0;
    expect((await budgetState()).overCap).toBe(true);
    clearAiSettingsCache();
    mockDb.settings.monthlyCapGhs = null;
    process.env.AI_MONTHLY_BUDGET_GHS = "50";
    expect((await budgetState()).capGhs).toBe(50);
  });

  it("usage summary: spend vs cap, calls per feature, recent failures", async () => {
    turnOn();
    spend(10, "ASK");
    spend(5, "ASK", "ERROR");
    spend(2, "PAPERS");
    spend(0, "PAPERS", "BLOCKED");
    const s = await usageSummary();
    expect(s).toMatchObject({ spentGhs: 17, capGhs: 100, percent: 17, calls: 4, overCap: false });
    expect(s.byFeature).toEqual([
      { feature: "ASK", calls: 2, failures: 1, blocked: 0, costGhs: 15 },
      { feature: "PAPERS", calls: 2, failures: 0, blocked: 1, costGhs: 2 },
    ]);
    expect(s.recentFailures.map((f) => f.status)).toEqual(["ERROR", "BLOCKED"]);
  });
});

describe("metered run", () => {
  const user = { category: "Administrator", username: "admin" };
  const prompt = { system: "School rules. Office 024 233 2420", user: "Draft a note for 0244123456 / a@b.com", promptVersion: "general@1.0.0" };

  it("AI off: refused before the provider is touched, nothing spent", async () => {
    const provider = createFakeProvider([{ text: "x" }]);
    setAiProviderForTests(provider);
    await expect(runText({ feature: "ANNOUNCEMENTS", user, prompt })).rejects.toMatchObject({ statusCode: 403, code: "AI_DISABLED", details: { reason: "SERVER_OFF" } });
    turnOn();
    mockDb.settings.enabled = false;
    clearAiSettingsCache();
    await expect(runText({ feature: "ANNOUNCEMENTS", user, prompt })).rejects.toMatchObject({ details: { reason: "SCHOOL_OFF" } });
    mockDb.settings.enabled = true;
    mockDb.settings.featureToggles = { ANNOUNCEMENTS: false };
    clearAiSettingsCache();
    await expect(runText({ feature: "ANNOUNCEMENTS", user, prompt })).rejects.toMatchObject({ details: { reason: "FEATURE_OFF" } });
    await expect(runText({ feature: "REMARKS", user, prompt })).rejects.toMatchObject({ details: { reason: "FEATURE_OFF" } }); // later features start off
    expect(provider.calls).toHaveLength(0);
  });

  it("success: redacts what is sent, logs one OK row with prompt version and cost", async () => {
    turnOn();
    const provider = createFakeProvider([{ text: "Dear Parent", usage: { inputTokens: 1000, outputTokens: 200 } }]);
    setAiProviderForTests(provider);
    const res = await runText({ feature: "ANNOUNCEMENTS", user, prompt });
    expect(res).toMatchObject({ text: "Dear Parent", promptVersion: "general@1.0.0", model: "gemini-3.1-flash-lite" });
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).not.toMatch(/024 233 2420|0244123456|a@b\.com/);
    expect(sent).toMatch(/\[phone\].*\[email\]/);
    expect(mockDb.usage).toHaveLength(1);
    expect(mockDb.usage[0]).toMatchObject({ feature: "ANNOUNCEMENTS", userRef: "OFFICE:admin", status: "OK", promptVersion: "general@1.0.0", inputTokens: 1000, outputTokens: 200, costMicros: 550 });
    expect(mockDb.usage[0].costGhs).toBeGreaterThan(0);
  });

  it("over the cap: friendly 429, a BLOCKED row, no provider call", async () => {
    turnOn();
    spend(100);
    const provider = createFakeProvider([{ text: "x" }]);
    setAiProviderForTests(provider);
    await expect(runText({ feature: "ASK", user, prompt })).rejects.toMatchObject({ statusCode: 429, message: expect.stringMatching(/budget is used up.*by hand/) });
    expect(provider.calls).toHaveLength(0);
    expect(mockDb.usage.at(-1)).toMatchObject({ status: "BLOCKED", errorClass: "QUOTA" });
  });

  it("a provider failure: an ERROR row with the class (tokens of failed attempts counted) and a friendly error", async () => {
    turnOn();
    setAiProviderForTests(createFakeProvider([{ text: "nope" }, { text: "still nope" }]));
    const schema = { type: "object", required: ["a"] };
    const e = await runJson({ feature: "PAPERS", user: { userRole: "STAFF", id: 3 }, prompt, schema }).catch((x) => x);
    expect(e).toMatchObject({ statusCode: 502, code: "AI_FAILED", details: { errorClass: "MALFORMED_OUTPUT" }, expose: true });
    expect(mockDb.usage[0]).toMatchObject({ status: "ERROR", errorClass: "MALFORMED_OUTPUT", userRef: "STAFF:3", inputTokens: 200 });

    setAiProviderForTests(createFakeProvider([{ error: Object.assign(new Error("blocked"), { status: 429 }) }]));
    await expect(runText({ feature: "ASK", user, prompt })).rejects.toMatchObject({ statusCode: 503, details: { errorClass: "RATE_LIMIT" } });
    expect(mockDb.usage.at(-1)).toMatchObject({ status: "ERROR", errorClass: "RATE_LIMIT" });
  });

  it("runJson returns validated data", async () => {
    turnOn();
    setAiProviderForTests(createFakeProvider([{ json: { a: 1 } }]));
    const res = await runJson({ feature: "BRIEFING", user, prompt, schema: { type: "object", required: ["a"] } });
    expect(res.data).toEqual({ a: 1 });
  });

  it("streamText yields chunks and logs once at the end", async () => {
    turnOn();
    setAiProviderForTests(createFakeProvider([{ text: "One two" }]));
    let text = "";
    for await (const c of streamText({ feature: "ASK", user, prompt })) if (c.type === "text") text += c.text;
    expect(text).toBe("One two");
    expect(mockDb.usage).toHaveLength(1);
    expect(mockDb.usage[0]).toMatchObject({ status: "OK", inputTokens: 100 });
  });

  it("tool loop: runs tools, redacts their results, one usage row per turn, stops at the answer", async () => {
    turnOn();
    const provider = createFakeProvider([
      { toolCalls: [{ name: "find_pupil", args: { name: "Ama" } }, { name: "missing_tool", args: {} }] },
      { text: "Ama owes GH₵ 350." },
    ]);
    setAiProviderForTests(provider);
    const handler = jest.fn(async () => ({ fName: "Ama", feesOwing: 350, parent: { contact: "0244123456" } }));
    const res = await runToolLoop({
      feature: "ASK",
      user,
      prompt,
      tools: [{ name: "find_pupil", description: "Find a pupil", parameters: { type: "object" }, handler }],
    });
    expect(res).toMatchObject({ text: "Ama owes GH₵ 350.", toolsUsed: ["find_pupil", "missing_tool"], turns: 2 });
    expect(handler).toHaveBeenCalledWith({ name: "Ama" }, { user, feature: "ASK" });
    const second = provider.calls[1];
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg.toolResults[0].result).toEqual({ fName: "Ama", feesOwing: 350, parent: {} });
    expect(toolMsg.toolResults[1].result).toEqual({ error: "There is no tool called missing_tool." });
    expect(second.tools.map((t) => t.name)).toEqual(["find_pupil"]); // handlers are not sent
    expect(mockDb.usage.filter((u) => u.status === "OK")).toHaveLength(2);
  });

  it("tool loop stops at the cap between turns", async () => {
    turnOn();
    mockDb.settings.monthlyCapGhs = 0.0001;
    setAiProviderForTests(createFakeProvider([{ toolCalls: [{ name: "t" }], usage: { inputTokens: 1_000_000, outputTokens: 0 } }, { text: "never" }]));
    await expect(
      runToolLoop({ feature: "ASK", user, prompt, tools: [{ name: "t", description: "", parameters: {}, handler: async () => 1 }] })
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("suggestions", () => {
  const admin = "OFFICE:admin";
  const make = (feature = "ANNOUNCEMENTS") =>
    createSuggestion({ feature, entityType: "POST", content: { title: "Sports day", body: "Dear Parent" }, model: "m", promptVersion: "announcement@1.0.0", createdBy: admin });

  it("a new draft is PENDING; content must be an object", async () => {
    const s = await make();
    expect(s).toMatchObject({ suggestionId: 1, status: "PENDING", promptVersion: "announcement@1.0.0" });
    await expect(createSuggestion({ feature: "ANNOUNCEMENTS", entityType: "POST", content: "text" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createSuggestion({ feature: "NOPE", entityType: "X", content: {} })).rejects.toThrow(/Unknown AI feature/);
  });

  it("edit -> EDITED (still a draft), using the feature's content check", async () => {
    registerAcceptHandler("ANNOUNCEMENTS", jest.fn(), { validateContent: (c) => (c.body ? null : "The notice needs some text.") });
    await make();
    await expect(editSuggestion(1, { title: "x" }, { actor: admin })).rejects.toMatchObject({ statusCode: 400, message: "The notice needs some text." });
    const e = await editSuggestion(1, { title: "x", body: "y" }, { actor: admin });
    expect(e).toMatchObject({ status: "EDITED", reviewedBy: admin, content: { body: "y" } });
    expect(mockDb.suggestions[0].status).toBe("EDITED");
  });

  it("accept dispatches to the feature's handler, inside the transaction, once", async () => {
    const accept = jest.fn(async () => ({ entityId: 77 }));
    registerAcceptHandler("ANNOUNCEMENTS", accept);
    await make();
    const a = await acceptSuggestion("1", { actor: admin });
    expect(a).toMatchObject({ status: "ACCEPTED", entityId: "77", reviewedBy: admin });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ suggestionId: 1, content: { title: "Sports day", body: "Dear Parent" } }), {
      transaction: expect.objectContaining({ LOCK: expect.anything() }),
      actor: admin,
    });
    // double click: same answer, handler not run again
    await expect(acceptSuggestion(1, { actor: admin })).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(accept).toHaveBeenCalledTimes(1);
    // final states
    await expect(rejectSuggestion(1, { actor: admin })).rejects.toMatchObject({ statusCode: 409 });
    await expect(editSuggestion(1, { a: 1 }, { actor: admin })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a feature with no handler can't be accepted, and the draft is left alone", async () => {
    await make("BRIEFING");
    await expect(acceptSuggestion(1, { actor: admin })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/can't be accepted yet/) });
    expect(mockDb.suggestions[0].status).toBe("PENDING");
  });

  it("a handler that throws leaves the draft open (the transaction rolls back)", async () => {
    registerAcceptHandler("ANNOUNCEMENTS", async () => {
      throw Object.assign(new Error("Term is closed"), { statusCode: 409 });
    });
    await make();
    await expect(acceptSuggestion(1, { actor: admin })).rejects.toThrow("Term is closed");
    expect(mockDb.suggestions[0].status).toBe("PENDING");
  });

  it("reject closes it (twice is fine); a rejected draft can't be accepted", async () => {
    registerAcceptHandler("ANNOUNCEMENTS", jest.fn());
    await make();
    await expect(rejectSuggestion(1, { actor: admin })).resolves.toMatchObject({ status: "REJECTED" });
    await expect(rejectSuggestion(1, { actor: admin })).resolves.toMatchObject({ status: "REJECTED" });
    await expect(acceptSuggestion(1, { actor: admin })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("handlers: one per feature, known features only", () => {
    registerAcceptHandler("PAPERS", jest.fn());
    expect(() => registerAcceptHandler("PAPERS", jest.fn())).toThrow(/already registered/);
    expect(() => registerAcceptHandler("NOPE", jest.fn())).toThrow(/Unknown/);
  });

  it("bad ids are 404; scope narrows who sees a draft", async () => {
    await make();
    await expect(acceptSuggestion("1; drop", { actor: admin })).rejects.toMatchObject({ statusCode: 404 });
    await expect(rejectSuggestion(1, { actor: "STAFF:3", scope: { createdBy: "STAFF:3" } })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("list filters by feature / status / createdBy, and validates them", async () => {
    await make();
    await make("PAPERS");
    expect((await listSuggestions({ feature: "PAPERS" })).suggestions).toHaveLength(1);
    expect((await listSuggestions({ status: "PENDING,EDITED" })).suggestions).toHaveLength(2);
    expect((await listSuggestions({ limit: "1" })).total).toBe(2);
    await expect(listSuggestions({ status: "DONE" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(listSuggestions({ feature: "X" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
