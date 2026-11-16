// AI-8: AI-drafted announcements (models mocked, fake AI provider, no network).
// The date/time guard, SMS length and part counting, tone in the prompt, the
// route's roles / switches / budget, redaction of the brief, and what accept
// does (a DRAFT post with no notification; an SMS is never sent).
jest.mock("../config/auth.js", () => ({ __esModule: true, JWT_SECRET: "test-secret", JWT_ALGORITHM: "HS256" }));
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } })), query: jest.fn() },
}));
jest.mock("../services/storage.js", () => ({ __esModule: true, saveUpload: jest.fn(), storage: { remove: jest.fn() }, sendStoredFile: jest.fn(), uploadOne: () => (req, res, next) => next() }));
jest.mock("../services/notify.js", () => ({ __esModule: true, notifyPostPublished: jest.fn(async () => null) }));
jest.mock("../services/messaging.js", () => ({ __esModule: true, sendSMSMessage: jest.fn(async () => ({})) }));
jest.mock("../services/school.js", () => ({
  __esModule: true,
  getSchoolSettings: jest.fn(async () => ({ name: "PERFECT PEACE PREPARATORY SCHOOL", shortName: "Perfect Peace" })),
}));

const mockDb = { settings: null, usage: [], suggestions: [], nextId: 1 };
jest.mock("../models/index.js", () => {
  const { Op } = jest.requireActual("sequelize");
  const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
  const model = () => ({
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    findByPk: jest.fn(async () => null),
    findAndCountAll: jest.fn(async () => ({ rows: [], count: 0 })),
    create: jest.fn(async (v) => ({ eventId: 55, ...v })),
    update: jest.fn(async () => [1]),
    destroy: jest.fn(async () => 1),
    count: jest.fn(async () => 0),
  });
  const inMonth = (row, where) => !where?.createdAt || (row.createdAt >= where.createdAt[Op.gte] && row.createdAt < where.createdAt[Op.lt]);
  return {
    __esModule: true,
    Event: model(),
    PostLike: model(),
    PostComment: model(),
    PollOption: model(),
    PollVote: model(),
    Class: model(),
    Student: model(),
    Teacher: model(),
    AiSettings: { findOne: jest.fn(async () => ({ ...mockDb.settings })), update: jest.fn() },
    AiUsageLog: {
      create: jest.fn(async (row) => {
        mockDb.usage.push(row);
        return row;
      }),
      sum: jest.fn(async (field, { where }) => mockDb.usage.filter((r) => inMonth(r, where)).reduce((t, r) => t + Number(r[field] || 0), 0)),
      findAll: jest.fn(async () => []),
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
      findAll: jest.fn(async () => mockDb.suggestions),
      findAndCountAll: jest.fn(async () => ({ rows: mockDb.suggestions, count: mockDb.suggestions.length })),
      update: jest.fn(async (patch, { where }) => {
        Object.assign(mockDb.suggestions.find((s) => s.suggestionId === where.suggestionId), patch);
        return [1];
      }),
    },
  };
});

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { Event } from "../models/index.js";
import { notifyPostPublished } from "../services/notify.js";
import { sendSMSMessage } from "../services/messaging.js";
import { aiRouter } from "../routes/aiRoutes.js";
import { errorHandler } from "../utils/errorHandling.js";
import { clearAiSettingsCache } from "../services/ai/settings.js";
import { setAiProviderForTests } from "../services/ai/client.js";
import { createFakeProvider } from "../services/ai/providers/fake.js";
import { acceptSuggestion, editSuggestion, rejectSuggestion } from "../services/ai/suggestions.js";
import { checkDraft, parseDraftRequest } from "../services/aiAnnouncements.js";
import { ungroundedSpecifics } from "../utils/dateGuard.js";
import { normaliseSms, smsInfo, smsLimit } from "../utils/sms.js";

const app = express();
app.use(express.json());
app.use("/", aiRouter);
app.use(errorHandler);

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const T = {
  admin: sign({ category: "Administrator", username: "admin", teacherId: null }),
  accountant: sign({ category: "Accountant", username: "acc", teacherId: null }),
  classTeacher: sign({ category: "Class Teacher", username: "ct", teacherId: 3 }),
  teacher: sign({ id: 3, userRole: "STAFF" }),
  pupil: sign({ id: 7, userRole: "STU" }),
};
const draft = (body, token = T.admin) => request(app).post("/ai/announcements/draft").set("Authorization", `Bearer ${token}`).send(body);

const NOW = new Date("2026-11-16T09:00:00Z"); // a Monday
const ENV = { ...process.env };
const turnOn = () => {
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  mockDb.settings.enabled = true;
};
let provider;
const script = (steps) => {
  provider = createFakeProvider(steps);
  setAiProviderForTests(provider);
  return provider;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  delete process.env.AI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_MONTHLY_BUDGET_GHS;
  mockDb.settings = { aiSettingsId: 1, enabled: false, featureToggles: {}, monthlyCapGhs: 100, tone: {} };
  mockDb.usage = [];
  mockDb.suggestions = [];
  mockDb.nextId = 1;
  clearAiSettingsCache();
  setAiProviderForTests(null);
});
afterAll(() => {
  process.env = ENV;
  setAiProviderForTests(null);
});

const NEWS = { mode: "news", purpose: "Tell parents about sports day", audience: "Parents of all pupils", keyFacts: ["Sports day on Friday 20th November 2026", "Starts 8:30am", "Pupils wear house colours"] };
const GOOD_NEWS = { title: "Sports day", body: "Dear Parent/Guardian,\n\nSports day is on Friday 20th November 2026 and starts at 8:30am. Pupils should wear their house colours." };

// ------------------------------------------------------------------ guard
describe("date/time guard", () => {
  const u = (text, facts) => ungroundedSpecifics(text, facts, { now: NOW });

  it("refuses a date that is not in the key facts and allows one that is", () => {
    expect(u("Sports day is on 21 November.", ["Sports day 20 November"])).toEqual(["21 November"]);
    expect(u("Sports day is on 20 November.", ["Sports day 20 November"])).toEqual([]);
    expect(u("We reopen on Monday.", ["We reopen soon"])).toEqual(["Monday"]);
    expect(u("Fees are due in 2027.", ["Fees are due next year"])).toEqual(["2027"]);
    expect(u("No dates here at all.", [])).toEqual([]);
  });

  it("reads the same date written different ways (day first, as in Ghana)", () => {
    expect(u("On Friday 14th November 2025 we close.", ["Close 14/11/2025"])).toEqual([]);
    expect(u("We close on 14/11.", ["Friday 14th November"])).toEqual([]);
    expect(u("We close on November 14th.", ["14-11-2026"])).toEqual([]);
    expect(u("We close on 2026-11-14.", ["14 Nov 2026"])).toEqual([]);
    expect(u("Mid-term is 4-6 December.", ["Mid-term break 4th to 6th December"])).toEqual([]);
    expect(u("We close on 15/11.", ["Close 14/11"])).toEqual(["15/11"]);
    // 11/14 is not 14 November (day first)
    expect(u("We close on 11/14.", ["Close 14/11"])).toEqual(["11/14"]);
  });

  it("catches a weekday that is wrong for the date", () => {
    // 14 November 2026 is a Saturday; with no year a date this close means this year.
    expect(u("Sports day is on Friday 14th November.", ["14/11"])).toEqual(["Friday 14th November"]);
    expect(u("Sports day is on Saturday 14th November.", ["14/11"])).toEqual([]);
    expect(u("See you on Saturday.", ["14/11/2026"])).toEqual([]);
    expect(u("See you on Friday.", ["14/11/2026"])).toEqual(["Friday"]);
    // A weekday the office typed is taken as given.
    expect(u("Friday 14th November", ["Friday 14th November"])).toEqual([]);
  });

  it("times: same time in another form passes, a different time does not", () => {
    expect(u("It starts at 3:30pm.", ["Starts 15:30"])).toEqual([]);
    expect(u("It starts at 15.30.", ["Starts 3.30 pm"])).toEqual([]);
    expect(u("It starts at 3pm.", ["Starts 3:00 p.m."])).toEqual([]);
    expect(u("It starts at noon.", ["Starts 12pm"])).toEqual([]);
    expect(u("It starts at 4pm.", ["Starts 3pm"])).toEqual(["4pm"]);
    expect(u("Come at 9am.", ["Come early"])).toEqual(["9am"]);
  });

  it("money and term numbers are not dates or times", () => {
    expect(u("Pay GH₵ 5.50 for the 2nd term.", ["GH₵ 5.50 for lunch"])).toEqual([]);
    expect(u("Pay GHS 12.30 now.", ["Pay soon"])).toEqual([]);
  });
});

// ------------------------------------------------------------------ SMS counting
describe("SMS length and parts", () => {
  it("plain GSM: 160 in one part, 153 per part after that", () => {
    expect(smsInfo("a".repeat(160))).toMatchObject({ encoding: "GSM", chars: 160, parts: 1 });
    expect(smsInfo("a".repeat(161))).toMatchObject({ encoding: "GSM", chars: 161, parts: 2 });
    expect(smsInfo("a".repeat(306))).toMatchObject({ parts: 2 });
    expect(smsInfo("a".repeat(307))).toMatchObject({ parts: 3 });
    expect(smsInfo("")).toMatchObject({ chars: 0, parts: 0 });
    expect(smsLimit(1)).toBe(160);
    expect(smsLimit(2)).toBe(306);
  });

  it("^ { } [ ] ~ | \\ € count as two", () => {
    expect(smsInfo("[a]")).toMatchObject({ encoding: "GSM", chars: 5 });
    expect(smsInfo("€".repeat(80))).toMatchObject({ chars: 160, parts: 1 });
    expect(smsInfo("€".repeat(81))).toMatchObject({ chars: 162, parts: 2 });
  });

  it("Unicode (₵, curly quotes, Twi letters, emoji): 70 in one part, 67 per part", () => {
    expect(smsInfo("GH₵ 5")).toMatchObject({ encoding: "UNICODE", chars: 5, parts: 1 });
    expect(smsInfo("ɛ".repeat(70))).toMatchObject({ encoding: "UNICODE", parts: 1 });
    expect(smsInfo("ɛ".repeat(71))).toMatchObject({ parts: 2 });
    expect(smsInfo("ɛ".repeat(135))).toMatchObject({ parts: 3 });
    expect(smsLimit(1, "UNICODE")).toBe(70);
    expect(smsLimit(2, "UNICODE")).toBe(134);
  });

  it("normaliseSms keeps a draft in plain GSM", () => {
    const t = normaliseSms("Dear Parent, it’s “sports day” — fee GH₵ 5…\n\n\nThanks");
    expect(t).toBe("Dear Parent, it's \"sports day\" - fee GHC 5...\nThanks");
    expect(smsInfo(t).encoding).toBe("GSM");
  });

  it("checkDraft refuses an SMS over the parts asked for, in its encoding", () => {
    const one = { mode: "sms", length: 1, keyFacts: [] };
    expect(checkDraft({ text: "a".repeat(160) }, one).value.text).toHaveLength(160);
    expect(checkDraft({ text: "a".repeat(161) }, one)).toMatchObject({ guard: "SMS_LENGTH", chars: 161, max: 160 });
    expect(checkDraft({ text: "ɛ".repeat(71) }, one)).toMatchObject({ guard: "SMS_LENGTH", max: 70 });
    expect(checkDraft({ text: "a".repeat(300) }, { ...one, length: 2 }).value).toBeTruthy();
  });
});

// ------------------------------------------------------------------ request
describe("request checks", () => {
  it("validates mode, purpose, facts and length", () => {
    expect(() => parseDraftRequest({ mode: "email", purpose: "x" })).toThrow(/news.*sms/);
    expect(() => parseDraftRequest({ mode: "news" })).toThrow(/what the notice is for/);
    expect(() => parseDraftRequest({ mode: "sms", purpose: "x", length: 3 })).toThrow(/1 or 2 parts/);
    expect(() => parseDraftRequest({ mode: "news", purpose: "x", length: "huge" })).toThrow(/length/);
    expect(() => parseDraftRequest({ mode: "news", purpose: "x", keyFacts: Array(13).fill("a") })).toThrow(/at most 12/);
    expect(parseDraftRequest({ purpose: " x ", keyFacts: ["  a ", "", "b"] })).toMatchObject({ mode: "news", purpose: "x", keyFacts: ["a", "b"], length: "medium" });
    expect(parseDraftRequest({ mode: "sms", purpose: "x", keyFacts: "a\nb" })).toMatchObject({ length: 1, keyFacts: ["a", "b"] });
  });
});

// ------------------------------------------------------------------ route
describe("POST /ai/announcements/draft", () => {
  it("roles: Administrator only (news writers ∩ bulk SMS senders)", async () => {
    turnOn();
    script([{ json: GOOD_NEWS }]);
    for (const who of ["accountant", "classTeacher", "teacher", "pupil"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await draft(NEWS, T[who]);
      expect([who, res.status]).toEqual([who, 403]);
    }
    expect((await request(app).post("/ai/announcements/draft").send(NEWS)).status).toBe(401);
    expect(provider.calls).toHaveLength(0);
    expect((await draft(NEWS)).status).toBe(200);
  });

  it("AI off: 403 AI_DISABLED, nothing called", async () => {
    script([{ json: GOOD_NEWS }]);
    const res = await draft(NEWS);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AI_DISABLED", reason: "SERVER_OFF" });
    turnOn();
    mockDb.settings.featureToggles = { ANNOUNCEMENTS: false };
    clearAiSettingsCache();
    expect((await draft(NEWS)).body).toMatchObject({ code: "AI_DISABLED", reason: "FEATURE_OFF" });
    expect(provider.calls).toHaveLength(0);
  });

  it("over the monthly cap: 429 AI_QUOTA, the model is not called", async () => {
    turnOn();
    mockDb.settings.monthlyCapGhs = 10;
    mockDb.usage.push({ feature: "ASK", status: "OK", costGhs: 10, createdAt: new Date() });
    script([{ json: GOOD_NEWS }]);
    const res = await draft(NEWS);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "AI_QUOTA", capGhs: 10 });
    expect(provider.calls).toHaveLength(0);
  });

  it("news: a grounded draft is stored as a PENDING suggestion, with the tone in the prompt", async () => {
    turnOn();
    script([{ json: GOOD_NEWS }]);
    const res = await draft({ ...NEWS, post: { audience: "STAFF" } });
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toMatchObject({
      feature: "ANNOUNCEMENTS",
      entityType: "POST",
      status: "PENDING",
      promptVersion: "announcement@1.0.0",
      createdBy: "OFFICE:admin",
      content: { mode: "news", title: "Sports day", keyFacts: NEWS.keyFacts, post: { audience: "STAFF" } },
    });
    const sent = provider.calls[0];
    expect(sent.system).toContain("Tone: formal");
    expect(sent.system).toContain('open with "Dear Parent/Guardian"');
    expect(sent.system).toContain("British English");
    expect(sent.system).toContain("PERFECT PEACE PREPARATORY SCHOOL");
    expect(sent.messages[0].content).toContain("- Starts 8:30am");
    expect(sent.json.schema.required).toEqual(["title", "body"]);
    expect(Event.create).not.toHaveBeenCalled(); // drafting writes no post
  });

  it("the tone follows Settings -> AI", async () => {
    turnOn();
    mockDb.settings.tone = { formal: false, salutation: "Hello families", britishSpelling: false };
    script([{ json: GOOD_NEWS }]);
    await draft(NEWS);
    const { system } = provider.calls[0];
    expect(system).toContain("warm and friendly");
    expect(system).toContain('open with "Hello families"');
    expect(system).toContain("American English");
  });

  it("an invented date is retried once with the reason, then refused plainly", async () => {
    turnOn();
    const invented = { title: "Sports day", body: "Sports day is on Friday 27th November 2026 at 8:30am." };
    script([{ json: invented }, { json: invented }]);
    const res = await draft(NEWS);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "AI_FAILED", guard: "DATES", flagged: ["Friday 27th November 2026"] });
    expect(res.body.message).toMatch(/isn't in your key facts.*Friday 27th November 2026.*by hand/);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].messages.at(-1).content).toMatch(/Friday 27th November 2026.*key facts do not give/);
    expect(mockDb.suggestions).toHaveLength(0);
  });

  it("an invented time on the first try, a grounded draft on the retry: stored", async () => {
    turnOn();
    script([{ json: { title: "Sports day", body: "Sports day is on 20/11/2026 and starts at 9am." } }, { json: GOOD_NEWS }]);
    const res = await draft(NEWS);
    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    expect(res.body.suggestion.content.body).toBe(GOOD_NEWS.body);
  });

  it("redacts phone numbers and emails in the brief before the model sees it", async () => {
    turnOn();
    script([{ json: GOOD_NEWS }]);
    const res = await draft({
      ...NEWS,
      purpose: "Ask parents to call 024 233 2420 about sports day",
      keyFacts: [...NEWS.keyFacts, "Questions: +233 55 123 4567 or office@perfectpeace.edu.gh"],
    });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).not.toMatch(/233 2420|123 4567|office@perfectpeace/);
    expect(sent).toContain("[phone]");
    expect(sent).toContain("[email]");
    expect(res.body.suggestion.content.keyFacts.at(-1)).toBe("Questions: [phone] or [email]");
  });

  it("sms: plain characters, counted, within the parts asked for", async () => {
    turnOn();
    script([{ json: { text: "Dear Parent, sports day is on Friday 20th November 2026 from 8:30am. Pupils wear house colours — Perfect Peace" } }]);
    const res = await draft({ ...NEWS, mode: "sms" });
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toMatchObject({ entityType: "SMS", content: { mode: "sms", length: 1 } });
    expect(res.body.suggestion.content.text).toContain("colours - Perfect Peace");
    expect(res.body.sms).toMatchObject({ encoding: "GSM", parts: 1 });
    expect(provider.calls[0].system).toContain("at most 160 characters");
    expect(provider.calls[0].json.schema.required).toEqual(["text"]);
  });

  it("sms: too long twice for 1 part -> refused with the count; 2 parts asked -> fits", async () => {
    turnOn();
    const long = { text: `Dear Parent, ${"sports day news ".repeat(14)}` }; // ~230 chars
    script([{ json: long }, { json: long }]);
    const res = await draft({ ...NEWS, mode: "sms", length: 1 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "AI_FAILED", guard: "SMS_LENGTH" });
    expect(res.body.message).toMatch(/1 SMS part .*limit is 160/);
    expect(provider.calls[1].messages.at(-1).content).toMatch(/at most 160/);

    script([{ json: long }]);
    const two = await draft({ ...NEWS, mode: "sms", length: 2 });
    expect(two.status).toBe(200);
    expect(two.body.sms.parts).toBe(2);
    expect(provider.calls[0].system).toContain("at most 306 characters");
  });

  it("a bad request is a 400 before any AI call", async () => {
    turnOn();
    script([{ json: GOOD_NEWS }]);
    expect((await draft({ mode: "news" })).status).toBe(400);
    expect((await draft({ mode: "sms", purpose: "x", length: 5 })).status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ accept
describe("accept / edit / reject", () => {
  const make = async (body) => {
    turnOn();
    const res = await draft(body);
    expect(res.status).toBe(200);
    return res.body.suggestion;
  };

  it("news: accept creates a DRAFT post (never published, no notification)", async () => {
    script([{ json: GOOD_NEWS }]);
    const s = await make({ ...NEWS, post: { audience: "STAFF" } });
    const out = await acceptSuggestion(s.suggestionId, { actor: "OFFICE:admin" });
    expect(out).toMatchObject({ status: "ACCEPTED", entityId: "55", applied: { mode: "news", postId: 55, status: "DRAFT" } });
    expect(Event.create).toHaveBeenCalledTimes(1);
    const [row, opts] = Event.create.mock.calls[0];
    expect(row).toMatchObject({ name: "Sports day", description: GOOD_NEWS.body, postType: "NEWS", status: "DRAFT", publishedAt: null, audience: "STAFF", createdBy: "admin" });
    expect(opts.transaction).toBeTruthy(); // inside the accept transaction
    expect(notifyPostPublished).not.toHaveBeenCalled();
    expect(sendSMSMessage).not.toHaveBeenCalled();
    // a second click does not make a second post
    await acceptSuggestion(s.suggestionId, { actor: "OFFICE:admin" });
    expect(Event.create).toHaveBeenCalledTimes(1);
  });

  it("news: an edited draft is what becomes the post", async () => {
    script([{ json: GOOD_NEWS }]);
    const s = await make(NEWS);
    await editSuggestion(s.suggestionId, { ...s.content, body: "Edited by the head." }, { actor: "OFFICE:admin" });
    await acceptSuggestion(s.suggestionId, { actor: "OFFICE:admin" });
    expect(Event.create.mock.calls[0][0]).toMatchObject({ description: "Edited by the head.", status: "DRAFT", audience: "ALL" });
    await expect(editSuggestion(s.suggestionId, { ...s.content, body: "" }, { actor: "OFFICE:admin" })).rejects.toThrow(/already accepted/);
  });

  it("an empty edit is refused", async () => {
    script([{ json: GOOD_NEWS }]);
    const s = await make(NEWS);
    await expect(editSuggestion(s.suggestionId, { ...s.content, body: " " }, { actor: "OFFICE:admin" })).rejects.toThrow(/needs some text/);
  });

  it("sms: accept returns the text for the SMS box and sends nothing", async () => {
    script([{ json: { text: "Dear Parent, sports day is on Friday 20th November 2026. Perfect Peace" } }]);
    const s = await make({ ...NEWS, mode: "sms" });
    const out = await acceptSuggestion(s.suggestionId, { actor: "OFFICE:admin" });
    expect(out.status).toBe("ACCEPTED");
    expect(out.applied).toMatchObject({ mode: "sms", text: "Dear Parent, sports day is on Friday 20th November 2026. Perfect Peace", sms: { parts: 1, encoding: "GSM" } });
    expect(sendSMSMessage).not.toHaveBeenCalled();
    expect(Event.create).not.toHaveBeenCalled();
    expect(notifyPostPublished).not.toHaveBeenCalled();
  });

  it("reject writes nothing anywhere", async () => {
    script([{ json: GOOD_NEWS }]);
    const s = await make(NEWS);
    expect((await rejectSuggestion(s.suggestionId, { actor: "OFFICE:admin" })).status).toBe("REJECTED");
    expect(Event.create).not.toHaveBeenCalled();
  });

  it("accept over HTTP is Administrator-only (AI-0 endpoint)", async () => {
    script([{ json: GOOD_NEWS }]);
    const s = await make(NEWS);
    const res = await request(app).post(`/ai/suggestions/${s.suggestionId}/accept`).set("Authorization", `Bearer ${T.classTeacher}`);
    expect(res.status).toBe(403);
    const ok = await request(app).post(`/ai/suggestions/${s.suggestionId}/accept`).set("Authorization", `Bearer ${T.admin}`);
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toMatchObject({ postId: 55, status: "DRAFT" });
  });
});
