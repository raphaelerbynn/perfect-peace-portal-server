// AI-1: Ask the school end to end with the fake provider (models mocked, no
// DB, no network): the fast path costs nothing, the budget, the Accountant's
// tools (offered and refused), the tool-iteration cap, the SSE event sequence,
// stopping when the client disconnects, the per-user hourly limit, and each
// user seeing only their own conversations.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import { EventEmitter } from "events";
import jwt from "jsonwebtoken";
import request from "supertest";

const mockDb = { settings: null, usage: [], convs: [], msgs: [], nextConv: 1, nextMsg: 1, queries: [] };

jest.mock("../config/database.js", () => {
  const actual = jest.requireActual("../config/database.js");
  actual.default.query = jest.fn(async (sql) => {
    mockDb.queries.push(sql);
    if (/s\.fees_owing >= :minAmount/.test(sql)) return [{ studentId: 1, fName: "Ama", lName: "Mensah", className: "Basic 4", owing: 850, count: 1, totalOwing: 850 }];
    if (/LIMIT :limit/.test(sql) && /FROM "dbo"\."Term" t/.test(sql)) return [{ termId: 12, term: "1", startDate: "2026-09-08", endDate: "2026-12-18", active: true, yearName: "2026/2027" }];
    if (/t\.active = TRUE\) OR t\.term_id/.test(sql)) return [{ termId: 12, term: "1", startDate: "2026-09-08", endDate: "2026-12-18", active: true }];
    return [];
  });
  return actual;
});
jest.mock("../services/dashboard.js", () => ({
  __esModule: true,
  getDashboardSummary: jest.fn(async () => ({ totalStudents: 420, activeStudents: 400, students: 400, boys: 210, girls: 190, totalStaff: 30, totalClasses: 14 })),
}));
jest.mock("../services/school.js", () => {
  const actual = jest.requireActual("../services/school.js");
  return { __esModule: true, ...actual, getSchoolSettings: jest.fn(async () => ({ name: "Perfect Peace School" })) };
});
jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  const { Op } = jest.requireActual("sequelize");
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date) && Op.gte in v) return row[k] >= v[Op.gte];
      if (v && typeof v === "object" && !(v instanceof Date) && Op.lt in v) return row[k] < v[Op.lt];
      return row[k] === v;
    });
  const table = (key, idKey, nextKey) => ({
    create: jest.fn(async (row) => {
      const r = { [idKey]: mockDb[nextKey]++, ...row };
      mockDb[key].push(r);
      return { ...r, get: () => ({ ...r }) };
    }),
    findOne: jest.fn(async ({ where }) => {
      const r = mockDb[key].find((x) => matches(x, where));
      return r ? { ...r } : null;
    }),
    findAll: jest.fn(async ({ where, order, limit }) => {
      let rows = mockDb[key].filter((x) => matches(x, where)).map((x) => ({ ...x }));
      if (order?.[0]) {
        const [[col, dir]] = order;
        rows.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "DESC" ? -1 : 1));
      }
      if (limit) rows = rows.slice(0, limit);
      return rows;
    }),
    count: jest.fn(async ({ where }) => mockDb[key].filter((x) => matches(x, where)).length),
    update: jest.fn(async (patch, { where }) => {
      mockDb[key].filter((x) => matches(x, where)).forEach((x) => Object.assign(x, patch));
      return [1];
    }),
    destroy: jest.fn(async ({ where }) => {
      const before = mockDb[key].length;
      mockDb[key] = mockDb[key].filter((x) => !matches(x, where));
      return before - mockDb[key].length;
    }),
  });
  return {
    __esModule: true,
    ...actual,
    AiSettings: { findOne: jest.fn(async () => ({ ...mockDb.settings })) },
    AiUsageLog: {
      create: jest.fn(async (r) => {
        mockDb.usage.push(r);
        return r;
      }),
      sum: jest.fn(async () => mockDb.usage.reduce((t, r) => t + Number(r.costGhs || 0), 0)),
      findAll: jest.fn(async () => []),
    },
    AiConversation: table("convs", "conversationId", "nextConv"),
    AiMessage: table("msgs", "messageId", "nextMsg"),
  };
});

const app = require("../index.js").default;
const { clearAiSettingsCache } = require("../services/ai/settings.js");
const { setAiProviderForTests } = require("../services/ai/client.js");
const { createFakeProvider } = require("../services/ai/providers/fake.js");
const { prepareAsk, runAsk } = require("../services/ai/ask/chat.js");
const { normaliseQuestion, tryFastPath } = require("../services/ai/ask/fastPath.js");
const { postAsk } = require("../controllers/askController.js");

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const ADMIN = { category: "Administrator", username: "head", teacherId: null };
const ACC = { category: "Accountant", username: "bursar", teacherId: null };
const T = {
  admin: sign(ADMIN),
  admin2: sign({ category: "Administrator", username: "deputy", teacherId: null }),
  accountant: sign(ACC),
  classTeacher: sign({ category: "Class Teacher", username: "ct", teacherId: 3 }),
  teacher: sign({ id: 3, userRole: "STAFF" }),
};

const ENV = { ...process.env };
const turnOn = () => {
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-not-real";
  mockDb.settings.enabled = true;
  clearAiSettingsCache();
};
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.AI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_ASK_PER_HOUR;
  Object.assign(mockDb, { settings: { aiSettingsId: 1, enabled: false, featureToggles: {}, monthlyCapGhs: 100, tone: {} }, usage: [], convs: [], msgs: [], nextConv: 1, nextMsg: 1, queries: [] });
  clearAiSettingsCache();
  setAiProviderForTests(null);
});
afterAll(() => {
  process.env = ENV;
  setAiProviderForTests(null);
});

/** Parse an SSE body into [{ type, ...data }]. */
const parseSse = (text) =>
  text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const type = /^event: (.+)$/m.exec(b)[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(b)[1]);
      expect(data.type).toBe(type);
      return data;
    });
const ask = (token, body) =>
  request(app).post("/ai/chat").set("Authorization", `Bearer ${token}`).send(body).buffer(true).parse((res, cb) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => cb(null, s));
  });
const collect = async (gen) => {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
};
const toolNamesOffered = (call) => (call.tools || []).map((t) => t.name).sort();

describe("the fast path", () => {
  it("normalises and refuses anything it can't answer for sure", async () => {
    expect(normaliseQuestion("  How many PUPILS do we have?? ")).toBe("how many pupils do we have");
    for (const q of ["how many pupils in class 4", "how many pupils and how many staff", "how many pupils last term", "top pupils", "how many pupils owe fees"]) {
      // eslint-disable-next-line no-await-in-loop
      expect([q, await tryFastPath(q, { user: ADMIN })]).toEqual([q, null]);
    }
    // the Accountant may not use staff_count: falls through to the model
    expect(await tryFastPath("how many staff", { user: ACC })).toBeNull();
    expect(await tryFastPath("how many staff", { user: ADMIN })).not.toBeNull();
  });

  it("answers 'how many pupils' with no AI call, no usage row and no cost, even over the cap", async () => {
    turnOn();
    mockDb.usage.push({ costGhs: 500, createdAt: new Date(), status: "OK" }); // over the GH₵ 100 cap
    const provider = createFakeProvider([{ text: "should not be used" }]);
    setAiProviderForTests(provider);
    const usageBefore = mockDb.usage.length;

    const res = await ask(T.accountant, { question: "How many pupils do we have?" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(["conversation", "tool", "text", "done"]);
    expect(events[2].text).toMatch(/\*\*400\*\* pupils are on the roll \(210 boys, 190 girls\)/);
    expect(events[3]).toMatchObject({ fastPath: true, costGhs: 0, status: "OK", toolsUsed: ["students_count"] });
    expect(provider.calls).toHaveLength(0);
    expect(mockDb.usage).toHaveLength(usageBefore);
    expect(mockDb.msgs.map((m) => [m.role, m.fastPath])).toEqual([
      ["USER", false],
      ["ASSISTANT", true],
    ]);
  });

  it("'what term is it' is answered from the term table", async () => {
    turnOn();
    mockDb.queries = [];
    const events = parseSse((await ask(T.admin, { question: "What term is it?" })).body);
    expect(events.find((e) => e.type === "text").text).toMatch(/^It is \*\*Term 1 2026\/2027\*\*\. It runs from 2026-09-08 to 2026-12-18/);
  });
});

describe("the budget and the switches", () => {
  it("over the cap: a non-fast question is a 429 AI_QUOTA before anything is saved or sent", async () => {
    turnOn();
    mockDb.usage.push({ costGhs: 100, createdAt: new Date(), status: "OK" });
    const provider = createFakeProvider([{ text: "x" }]);
    setAiProviderForTests(provider);
    const res = await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "Which class owes the most?" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "AI_QUOTA", capGhs: 100 });
    expect(provider.calls).toHaveLength(0);
    expect(mockDb.convs).toHaveLength(0);
    expect(mockDb.msgs).toHaveLength(0);
    expect(mockDb.usage.at(-1)).toMatchObject({ feature: "ASK", status: "BLOCKED", errorClass: "QUOTA" });
  });

  it("the cap reached between turns stops the loop with an AI_QUOTA error event", async () => {
    turnOn();
    mockDb.settings.monthlyCapGhs = 0.01;
    clearAiSettingsCache();
    setAiProviderForTests(createFakeProvider([{ toolCalls: [{ name: "students_count" }], usage: { inputTokens: 1_000_000 } }, { text: "never" }]));
    const prepared = await prepareAsk({ question: "Pupils please" }, ADMIN);
    const events = await collect(runAsk(prepared, ADMIN));
    expect(events.find((e) => e.type === "error")).toMatchObject({ code: "AI_QUOTA" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ERROR" });
    expect(mockDb.msgs.at(-1)).toMatchObject({ role: "ASSISTANT", status: "ERROR" });
  });

  it("over the cap, the Accountant is told the budget is used up but never the amounts (JSON)", async () => {
    turnOn();
    mockDb.usage.push({ costGhs: 100, createdAt: new Date(), status: "OK" });
    setAiProviderForTests(createFakeProvider([{ text: "x" }]));
    const res = await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.accountant}`).send({ question: "Which class owes the most?" });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ code: "AI_QUOTA", message: "This month's AI budget is used up; carry on by hand." });
  });

  it("the cap reached between turns: the Accountant's SSE error event has no amounts; the Administrator's does", async () => {
    turnOn();
    mockDb.settings.monthlyCapGhs = 0.01;
    clearAiSettingsCache();
    const script = () => [{ toolCalls: [{ name: "fees_owing_total" }], usage: { inputTokens: 1_000_000 } }, { text: "never" }];
    setAiProviderForTests(createFakeProvider(script()));
    let events = await collect(runAsk(await prepareAsk({ question: "Fees owing please" }, ACC), ACC));
    let err = events.find((e) => e.type === "error");
    expect(err).toEqual({ type: "error", code: "AI_QUOTA", message: "This month's AI budget is used up; carry on by hand." });
    expect(JSON.stringify(events)).not.toMatch(/GH₵|capGhs|spentGhs/);

    mockDb.usage = [];
    setAiProviderForTests(createFakeProvider(script()));
    events = await collect(runAsk(await prepareAsk({ question: "Fees owing please" }, ADMIN), ADMIN));
    err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ code: "AI_QUOTA", capGhs: 0.01, message: expect.stringMatching(/GH₵/) });
  });

  it("AI off: 403 AI_DISABLED; roles: Class Teacher and portal tokens 403", async () => {
    let res = await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "hi" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "AI_DISABLED", reason: "SERVER_OFF" });
    turnOn();
    for (const t of [T.classTeacher, T.teacher]) {
      // eslint-disable-next-line no-await-in-loop
      res = await request(app).post("/ai/chat").set("Authorization", `Bearer ${t}`).send({ question: "hi" });
      expect(res.status).toBe(403);
    }
    expect((await request(app).post("/ai/chat").send({ question: "hi" })).status).toBe(401);
  });

  it("an empty or very long question is a 400", async () => {
    turnOn();
    expect((await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "  " })).status).toBe(400);
    expect((await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "x".repeat(1001) })).status).toBe(400);
  });
});

describe("the tool loop over SSE", () => {
  it("events in order: conversation, tool started/finished, streamed text, done; usage per turn; answer saved", async () => {
    turnOn();
    const provider = createFakeProvider([
      { toolCalls: [{ name: "fees_students_owing", args: { minAmount: 500 } }] },
      { text: "| Pupil | Owes |\n|---|---|\n| Ama Mensah | GH₵ 850.00 |" },
    ]);
    setAiProviderForTests(provider);
    const res = await ask(T.admin, { question: "Who owes more than 500 cedis?" });
    expect(res.status).toBe(200);
    const events = parseSse(res.body);
    const types = events.map((e) => (e.type === "tool" ? `tool:${e.status}` : e.type));
    expect(types[0]).toBe("conversation");
    expect(types.slice(1, 3)).toEqual(["tool:started", "tool:finished"]);
    expect(events[1]).toMatchObject({ name: "fees_students_owing", label: "Checking fees" });
    expect(new Set(types.slice(3, -1))).toEqual(new Set(["text"]));
    expect(types.at(-1)).toBe("done");
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(text).toBe("| Pupil | Owes |\n|---|---|\n| Ama Mensah | GH₵ 850.00 |");
    expect(events.at(-1)).toMatchObject({ status: "OK", fastPath: false, toolsUsed: ["fees_students_owing"] });
    expect(events.at(-1).costGhs).toBeGreaterThan(0);

    // the tool result went back to the model, and the model was told who asks
    const second = provider.calls[1];
    const toolMsg = second.messages.find((m) => m.role === "tool");
    expect(toolMsg.toolResults[0].result).toMatchObject({ pupilsOwing: 1, pupils: [{ name: "Ama Mensah", owing: 850 }] });
    expect(provider.calls[0].system).toMatch(/Perfect Peace School/);
    expect(provider.calls[0].messages.at(-1).content).toMatch(/Asking: Administrator[\s\S]*Question:\nWho owes more than 500 cedis\?/);
    expect(mockDb.usage.filter((u) => u.feature === "ASK" && u.status === "OK")).toHaveLength(2);
    expect(mockDb.usage[0].promptVersion).toBe("ask@1.0.0");
    expect(mockDb.msgs.at(-1)).toMatchObject({ role: "ASSISTANT", status: "OK", toolsUsed: ["fees_students_owing"], promptVersion: "ask@1.0.0" });
    expect(mockDb.convs[0]).toMatchObject({ userRef: "OFFICE:head", title: "Who owes more than 500 cedis?" });
  });

  it("the Accountant is offered finance tools only, and a results tool the model asks for anyway is refused", async () => {
    turnOn();
    const provider = createFakeProvider([{ toolCalls: [{ name: "results_top_students", args: {} }] }, { text: "I can't look that up for you." }]);
    setAiProviderForTests(provider);
    mockDb.queries = [];
    const prepared = await prepareAsk({ question: "Who are the best pupils this term?" }, ACC);
    const events = await collect(runAsk(prepared, ACC));
    expect(toolNamesOffered(provider.calls[0])).toEqual(
      ["current_term", "fees_collection_by_class", "fees_collection_by_term", "fees_students_owing", "income_expense_summary", "students_count", "students_count_by_class"].sort()
    );
    expect(events.filter((e) => e.type === "tool").map((e) => e.status)).toEqual(["started", "failed"]);
    const toolMsg = provider.calls[1].messages.find((m) => m.role === "tool");
    expect(toolMsg.toolResults[0].result).toEqual({ error: "This is not something you can look up for this user." });
    expect(mockDb.queries.some((q) => /Student_result/.test(q))).toBe(false);
  });

  it("the Administrator is offered every tool", async () => {
    turnOn();
    const provider = createFakeProvider([{ text: "ok" }]);
    setAiProviderForTests(provider);
    await collect(runAsk(await prepareAsk({ question: "Anything" }, ADMIN), ADMIN));
    expect(provider.calls[0].tools).toHaveLength(15);
  });

  it("stops after 5 model turns with a 'narrow it down' note", async () => {
    turnOn();
    const provider = createFakeProvider([{ toolCalls: [{ name: "current_term" }] }]); // forever
    setAiProviderForTests(provider);
    const events = await collect(runAsk(await prepareAsk({ question: "Loop forever" }, ADMIN), ADMIN));
    expect(provider.calls).toHaveLength(5);
    expect(events.filter((e) => e.type === "tool" && e.status === "started")).toHaveLength(5);
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toMatch(/stopped after checking several things/);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "OK" });
    expect(mockDb.usage.filter((u) => u.status === "OK")).toHaveLength(5);
  });

  it("a provider failure: an error event (friendly message) then done, the answer saved as ERROR", async () => {
    turnOn();
    setAiProviderForTests(createFakeProvider([{ error: Object.assign(new Error("boom"), { status: 500 }) }]));
    const events = parseSse((await ask(T.admin, { question: "Fees by class" })).body);
    expect(events.map((e) => e.type)).toEqual(["conversation", "error", "done"]);
    expect(events[1]).toMatchObject({ code: "AI_FAILED", errorClass: "PROVIDER_ERROR", message: expect.stringMatching(/try again/i) });
    expect(events[2]).toMatchObject({ status: "ERROR" });
    expect(mockDb.usage.at(-1)).toMatchObject({ status: "ERROR" });
  });

  it("follow-up questions carry the conversation's history", async () => {
    turnOn();
    const provider = createFakeProvider([{ text: "First answer." }, { text: "Second answer." }]);
    setAiProviderForTests(provider);
    const first = parseSse((await ask(T.admin, { question: "First question" })).body);
    const conversationId = first[0].conversationId;
    await ask(T.admin, { question: "And the second?", conversationId });
    const msgs = provider.calls[1].messages;
    expect(msgs.slice(0, 2)).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer." },
    ]);
    expect(mockDb.convs).toHaveLength(1);
  });
});

describe("stopping when the client goes away", () => {
  // A provider whose stream sends a few words and then waits forever.
  const hangingProvider = () => {
    const p = {
      id: "hang",
      calls: [],
      async generate() {
        throw new Error("not used");
      },
      async stream(req) {
        p.calls.push(req);
        return (async function* gen() {
          yield { text: "Counting ", toolCalls: [] };
          await new Promise(() => {});
        })();
      },
    };
    return p;
  };

  it("an abort stops the stream at once, runs no more tools, and saves what was written as STOPPED", async () => {
    turnOn();
    const provider = hangingProvider();
    setAiProviderForTests(provider);
    const controller = new AbortController();
    const prepared = await prepareAsk({ question: "Slow one" }, ADMIN);
    const events = [];
    for await (const e of runAsk(prepared, ADMIN, { signal: controller.signal })) {
      events.push(e);
      if (e.type === "text") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "done", status: "STOPPED" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(provider.calls).toHaveLength(1);
    expect(mockDb.msgs.at(-1)).toMatchObject({ role: "ASSISTANT", status: "STOPPED", content: "Counting " });
  });

  it("the SSE handler aborts when the response closes (client disconnected)", async () => {
    turnOn();
    const provider = hangingProvider();
    setAiProviderForTests(provider);
    const res = new EventEmitter();
    const written = [];
    Object.assign(res, {
      writableEnded: false,
      destroyed: false,
      status: jest.fn(() => res),
      set: jest.fn(() => res),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk) => {
        written.push(chunk);
        if (/event: text/.test(chunk)) setImmediate(() => res.emit("close")); // the browser went away
        return true;
      }),
      end: jest.fn(() => {
        res.writableEnded = true;
      }),
    });
    const next = jest.fn();
    await postAsk({ body: { question: "Slow one" }, user: ADMIN }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ "Content-Type": "text/event-stream; charset=utf-8" }));
    expect(mockDb.msgs.at(-1)).toMatchObject({ status: "STOPPED" });
    expect(res.end).toHaveBeenCalled();
    expect(written.join("")).toMatch(/"status":"STOPPED"/);
  });
});

describe("the per-user limit", () => {
  const asked = (userRef, minutesAgo) =>
    mockDb.msgs.push({ messageId: mockDb.nextMsg++, conversationId: 1, userRef, role: "USER", content: "q", createdAt: new Date(Date.now() - minutesAgo * 60000) });

  it("20 questions in the last hour: the 21st is a friendly 429; older ones and other people's don't count", async () => {
    turnOn();
    setAiProviderForTests(createFakeProvider([{ text: "ok" }]));
    for (let i = 0; i < 19; i += 1) asked("OFFICE:head", 5);
    asked("OFFICE:head", 61); // over an hour ago
    for (let i = 0; i < 25; i += 1) asked("OFFICE:deputy", 5);
    expect((await ask(T.admin, { question: "Question 20" })).status).toBe(200);
    const res = await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "Question 21" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: "AI_ASK_LIMIT", limit: 20, used: 20, message: expect.stringMatching(/20 questions in the last hour/) });
    // the fast path is behind the limit too (it still uses the database)
    expect((await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "how many pupils" })).status).toBe(429);
  });

  it("AI_ASK_PER_HOUR changes the limit", async () => {
    turnOn();
    process.env.AI_ASK_PER_HOUR = "2";
    asked("OFFICE:head", 1);
    asked("OFFICE:head", 1);
    expect((await request(app).post("/ai/chat").set("Authorization", `Bearer ${T.admin}`).send({ question: "x" })).body).toMatchObject({ code: "AI_ASK_LIMIT", limit: 2 });
  });
});

describe("conversation history: each user sees only their own", () => {
  const seed = () => {
    const now = Date.now();
    mockDb.convs.push(
      { conversationId: 1, userRef: "OFFICE:head", title: "Mine (old)", createdAt: new Date(now - 7200000), updatedAt: new Date(now - 7200000) },
      { conversationId: 2, userRef: "OFFICE:deputy", title: "Not mine", createdAt: new Date(now), updatedAt: new Date(now) },
      { conversationId: 3, userRef: "OFFICE:head", title: "Mine (new)", createdAt: new Date(now - 60000), updatedAt: new Date(now - 60000) }
    );
    mockDb.msgs.push(
      { messageId: 1, conversationId: 1, userRef: "OFFICE:head", role: "USER", content: "Q", toolsUsed: [], fastPath: false, status: "OK" },
      { messageId: 2, conversationId: 1, userRef: "OFFICE:head", role: "ASSISTANT", content: "A", toolsUsed: ["current_term"], fastPath: true, status: "OK" },
      { messageId: 3, conversationId: 2, userRef: "OFFICE:deputy", role: "USER", content: "secret", toolsUsed: [], fastPath: false, status: "OK" }
    );
    mockDb.nextConv = 4;
    mockDb.nextMsg = 4;
  };
  const as = (t) => (r) => r.set("Authorization", `Bearer ${t}`);

  it("list mine (newest first), get mine, someone else's is a 404", async () => {
    seed();
    const list = await as(T.admin)(request(app).get("/ai/conversations"));
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((c) => c.title)).toEqual(["Mine (new)", "Mine (old)"]);
    const one = await as(T.admin)(request(app).get("/ai/conversations/1"));
    expect(one.body).toMatchObject({ conversationId: 1, messages: [{ role: "USER", content: "Q" }, { role: "ASSISTANT", content: "A", fastPath: true, toolsUsed: ["current_term"] }] });
    expect((await as(T.admin)(request(app).get("/ai/conversations/2"))).status).toBe(404);
    expect((await as(T.admin)(request(app).get("/ai/conversations/abc"))).status).toBe(404);
  });

  it("delete mine (with its messages); someone else's is a 404 and stays", async () => {
    seed();
    expect((await as(T.admin)(request(app).delete("/ai/conversations/2"))).status).toBe(404);
    expect(mockDb.convs.find((c) => c.conversationId === 2)).toBeTruthy();
    const del = await as(T.admin)(request(app).delete("/ai/conversations/1"));
    expect(del.body).toEqual({ deleted: true, conversationId: 1 });
    expect(mockDb.convs.map((c) => c.conversationId)).toEqual([2, 3]);
    expect(mockDb.msgs.map((m) => m.messageId)).toEqual([3]);
  });

  it("asking into someone else's conversation is a 404, nothing saved", async () => {
    seed();
    turnOn();
    const res = await as(T.admin)(request(app).post("/ai/chat")).send({ question: "how many pupils", conversationId: 2 });
    expect(res.status).toBe(404);
    expect(mockDb.msgs).toHaveLength(3);
  });

  it("history works with AI switched off; Class Teachers and portal tokens can't reach it", async () => {
    seed();
    expect((await as(T.accountant)(request(app).get("/ai/conversations"))).body).toEqual({ conversations: [] });
    expect((await as(T.classTeacher)(request(app).get("/ai/conversations"))).status).toBe(403);
    expect((await as(T.teacher)(request(app).get("/ai/conversations"))).status).toBe(403);
  });
});
