// AI-3: question papers. Routes end to end over an in-memory stand-in for the
// models (no DB) and the AI-0 fake provider (no network): teacher scope and
// ownership (404), writing by hand with AI off, generation with validation and
// the blind checker, regenerating one item, accepting a section, FINAL being
// read-only, the monthly cap, and the head teacher's read-only view.
process.env.JWT_KEY = "test-secret";
process.env.NODE_ENV = "test";

import jwt from "jsonwebtoken";
import request from "supertest";

jest.mock("../models/index.js", () => {
  const actual = jest.requireActual("../models/index.js");
  const { Op } = jest.requireActual("sequelize");
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const cmpOp = (val, ops) =>
    Object.getOwnPropertySymbols(ops).every((s) => {
      const x = ops[s];
      if (s === Op.gt) return Number(val) > Number(x);
      if (s === Op.gte) return Number(val) >= Number(x);
      if (s === Op.lt) return Number(val) < Number(x);
      if (s === Op.in) return x.map(String).includes(String(val));
      if (s === Op.ne) return String(val) !== String(x);
      return true;
    });
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      const val = row[k];
      if (v === null) return val == null;
      if (Array.isArray(v)) return v.map(String).includes(String(val));
      if (v && typeof v === "object" && !(v instanceof Date)) return cmpOp(val, v);
      return String(val) === String(v);
    });
  const sortBy = (rows, order) => {
    if (!order) return rows;
    return [...rows].sort((a, b) => {
      for (const [f, dir] of order) {
        const x = a[f] instanceof Date ? a[f].getTime() : a[f];
        const y = b[f] instanceof Date ? b[f].getTime() : b[f];
        if (x < y) return dir === "DESC" ? 1 : -1;
        if (x > y) return dir === "DESC" ? -1 : 1;
      }
      return 0;
    });
  };
  const withGet = (row) => Object.assign(clone(row), { get: () => clone(row) });
  const makeModel = (pk) => {
    const M = {
      rows: [],
      seq: 0,
      reset(rows = []) {
        M.rows = rows.map(clone);
        M.seq = 100;
      },
      findAll: jest.fn(async ({ where, order, limit, offset = 0 } = {}) => {
        let out = sortBy(M.rows.filter((r) => matches(r, where)), order).slice(offset);
        if (limit) out = out.slice(0, limit);
        return out.map(clone);
      }),
      findOne: jest.fn(async (o = {}) => (await M.findAll(o))[0] || null),
      findAndCountAll: jest.fn(async (o = {}) => ({ rows: await M.findAll(o), count: M.rows.filter((r) => matches(r, o.where)).length })),
      count: jest.fn(async ({ where } = {}) => M.rows.filter((r) => matches(r, where)).length),
      max: jest.fn(async (f, { where } = {}) => {
        const xs = M.rows.filter((r) => matches(r, where)).map((r) => Number(r[f]));
        return xs.length ? Math.max(...xs) : null;
      }),
      sum: jest.fn(async () => 0),
      create: jest.fn(async (data) => {
        const row = { [pk]: (M.seq += 1), ...clone(data) };
        M.rows.push(row);
        return withGet(row);
      }),
      bulkCreate: jest.fn(async (list) => Promise.all(list.map((d) => M.create(d)))),
      update: jest.fn(async (patch, { where } = {}) => {
        const hit = M.rows.filter((r) => matches(r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(patch)) {
            if (v && typeof v === "object" && typeof v.val === "string") {
              const m = /^(\w+) - 1$/.exec(v.val);
              r[k] = Number(r[m[1]]) - 1;
            } else r[k] = clone(v);
          }
        }
        return [hit.length];
      }),
      destroy: jest.fn(async ({ where } = {}) => {
        const before = M.rows.length;
        M.rows = M.rows.filter((r) => !matches(r, where));
        return before - M.rows.length;
      }),
    };
    return M;
  };
  const models = {
    QuestionPaper: makeModel("paperId"),
    Question: makeModel("questionId"),
    AiSuggestion: makeModel("suggestionId"),
    AiUsageLog: makeModel("usageId"),
    AiSettings: makeModel("aiSettingsId"),
    Teacher: makeModel("teacherId"),
    Class: makeModel("classId"),
    Subject: makeModel("subjectId"),
    Term: makeModel("termId"),
    TeachingAssignment: makeModel("teachingAssignmentId"),
    SchoolSettings: makeModel("schoolSettingsId"),
  };
  global.__papersDb = models;
  return { __esModule: true, ...actual, ...models };
});
jest.mock("../config/database.js", () => {
  const actual = jest.requireActual("../config/database.js");
  actual.default.transaction = jest.fn(async (fn) => fn({ LOCK: { UPDATE: "UPDATE" } }));
  return actual;
});

const app = require("../index.js").default;
const { setAiProviderForTests } = require("../services/ai/client.js");
const { createFakeProvider } = require("../services/ai/providers/fake.js");
const { clearAiSettingsCache } = require("../services/ai/settings.js");
const rules = require("../services/paperRules.js");
const db = global.__papersDb;

const sign = (p) => jwt.sign(p, "test-secret", { algorithm: "HS256", expiresIn: "1h" });
const T = {
  t3: sign({ id: 3, userRole: "STAFF" }),
  t4: sign({ id: 4, userRole: "STAFF" }),
  pupil: sign({ id: 7, userRole: "STU" }),
  admin: sign({ category: "Administrator", username: "head", teacherId: null }),
  accountant: sign({ category: "Accountant", username: "acc", teacherId: null }),
};
const as = (tok) => ({
  get: (u) => request(app).get(u).set("Authorization", `Bearer ${tok}`),
  post: (u, b) => request(app).post(u).set("Authorization", `Bearer ${tok}`).send(b || {}),
  patch: (u, b) => request(app).patch(u).set("Authorization", `Bearer ${tok}`).send(b || {}),
  put: (u, b) => request(app).put(u).set("Authorization", `Bearer ${tok}`).send(b || {}),
  del: (u) => request(app).delete(u).set("Authorization", `Bearer ${tok}`),
});

const ENV = { ...process.env };
const aiOn = () => {
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key";
  db.AiSettings.rows[0].enabled = true;
  clearAiSettingsCache();
};

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.AI_ENABLED;
  delete process.env.GEMINI_API_KEY;
  db.QuestionPaper.reset();
  db.Question.reset();
  db.AiSuggestion.reset();
  db.AiUsageLog.reset();
  db.AiUsageLog.sum.mockImplementation(async () => 0);
  db.AiSettings.reset([{ aiSettingsId: 1, enabled: false, featureToggles: {}, monthlyCapGhs: 100, tone: {} }]);
  db.SchoolSettings.reset();
  db.Teacher.reset([
    { teacherId: 3, fName: "Ama", lName: "Owusu", isDeleted: false, classId: null },
    { teacherId: 4, fName: "Kofi", lName: "Mensah", isDeleted: false, classId: null },
  ]);
  db.Class.reset([
    { classId: 5, name: "Basic 5", section: "Primary", teacherId: 4, isDeleted: false },
    { classId: 6, name: "KG 2", section: "KG", teacherId: 3, isDeleted: false },
  ]);
  db.Subject.reset([
    { subjectId: 10, name: "Mathematics", isDeleted: false },
    { subjectId: 11, name: "Science", isDeleted: false },
  ]);
  db.Term.reset([{ termId: 1, term: "1", active: true }]);
  // Teacher 3 teaches Maths in Basic 5; teacher 4 is its class teacher (and so takes Science there).
  db.TeachingAssignment.reset([{ teachingAssignmentId: 1, teacherId: 3, classId: 5, subjectId: 10, termId: 1 }]);
  clearAiSettingsCache();
  setAiProviderForTests(null);
});
afterAll(() => {
  process.env = ENV;
  setAiProviderForTests(null);
});

const MCQ_SECTION = { title: "Section A", type: "MCQ", count: 2, marksEach: 1, difficulty: "MIXED" };
const ESSAY_SECTION = { title: "Section B", type: "ESSAY", count: 1, marksEach: 10 };
const create = (body = {}) =>
  as(T.t3).post("/teacher/papers", { classId: 5, subjectId: 10, topics: ["Fractions"], sections: [MCQ_SECTION], ...body });

const mcq = (stem, key = "B", texts = ["1/4", "1/2", "3/4", "1"]) => ({
  stem,
  options: texts.map((text, i) => ({ key: "ABCD"[i], text })),
  answer: { key, accepted: null },
  markingScheme: [],
  explanation: "Half of a whole.",
  difficulty: "EASY",
});
const handMcq = (stem = "What is half of 10 cedis?") => ({
  stem,
  options: ["GH₵ 2", "GH₵ 5", "GH₵ 8", "GH₵ 10"],
  answer: { key: "B" },
});

// ---------------------------------------------------------------- pure rules

describe("paperRules: validation", () => {
  it("an MCQ needs exactly 4 distinct options and an answer among them", () => {
    expect(() => rules.validateQuestion({ stem: "Pick one", options: ["a", "b", "c"], answer: { key: "A" } }, "MCQ", 1)).toThrow(/3 options.*exactly 4/);
    expect(() => rules.validateQuestion({ stem: "Pick one", options: ["a", "b", "c", "A "], answer: { key: "A" } }, "MCQ", 1)).toThrow(/same/);
    expect(() => rules.validateQuestion({ stem: "Pick one", options: ["a", "b", "c", "d"], answer: { key: "E" } }, "MCQ", 1)).toThrow(/one of the options/);
    expect(() => rules.validateQuestion({ stem: "Pick one", options: ["a", "", "c", "d"], answer: { key: "A" } }, "MCQ", 1)).toThrow(/empty option/);
    const q = rules.validateQuestion({ stem: " Pick one ", options: ["a", "b", "c", "d"], answer: { key: "c" } }, "MCQ", 1);
    expect(q.options.map((o) => o.key)).toEqual(["A", "B", "C", "D"]);
    expect(q.answer).toEqual({ key: "C" });
    expect(q.stem).toBe("Pick one");
    expect(q.markingScheme).toEqual([{ point: "Correct answer: C", marks: 1 }]);
  });

  it("model output must key the options A to D in order", () => {
    const raw = mcq("Which is half?");
    raw.options[0].key = "B";
    expect(() => rules.validateQuestion(raw, "MCQ", 1, "Q1", { strictKeys: true })).toThrow(/keyed A, B, C and D/);
  });

  it("the stem can't be empty", () => {
    expect(() => rules.validateQuestion({ stem: "   ", answer: { key: "TRUE" } }, "TRUE_FALSE", 1)).toThrow(/no question text/);
  });

  it("a written question's marking scheme must add up to its marks", () => {
    const scheme = [
      { point: "States the rule", marks: 4 },
      { point: "Gives an example", marks: 4 },
    ];
    expect(() => rules.validateQuestion({ stem: "Explain erosion.", markingScheme: scheme }, "ESSAY", 10)).toThrow(/adds up to 8, not 10/);
    expect(rules.validateQuestion({ stem: "Explain erosion.", markingScheme: scheme }, "ESSAY", 8).marks).toBe(8);
    // Model output needs a scheme; a teacher writing by hand may leave it out.
    expect(() => rules.validateQuestion({ stem: "Explain erosion." }, "ESSAY", 8, "Q", { requireScheme: true })).toThrow(/no marking scheme/);
    expect(rules.validateQuestion({ stem: "Explain erosion." }, "ESSAY", 8).markingScheme).toEqual([]);
  });

  it("fill-in and short answer need an accepted answer", () => {
    expect(() => rules.validateQuestion({ stem: "2 + 2 = ______", answer: { accepted: [] } }, "FILL_IN", 1)).toThrow(/no accepted answer/);
    expect(rules.validateQuestion({ stem: "2 + 2 = ______", answer: { accepted: ["4", "four", "4"] } }, "FILL_IN", 1).answer).toEqual({ accepted: ["4", "four"] });
  });

  it("a generated section must have exactly the count asked for, without repeats", () => {
    const spec = { type: "MCQ", marksEach: 1 };
    expect(() => rules.validateGeneratedSection({ items: [mcq("One?")] }, spec, 2)).toThrow(/expected 2 questions, got 1/);
    expect(() => rules.validateGeneratedSection({ items: [mcq("One?"), mcq("one ?")] }, spec, 2)).toThrow(/repeats/);
    expect(() => rules.validateGeneratedSection({ items: [mcq("One?")] }, spec, 1, ["ONE"])).toThrow(/repeats/);
    expect(rules.sectionProblem({ items: [mcq("One?"), mcq("Two?")] }, spec, 2, [])).toBeNull();
  });

  it("the checker agrees or disagrees with the key", () => {
    const item = { answer: { key: "B" } };
    expect(rules.compareAnswer(item, "MCQ", "b) one half")).toEqual({ status: "AGREE", checkerAnswer: "B" });
    expect(rules.compareAnswer(item, "MCQ", "C")).toEqual({ status: "DISAGREE", checkerAnswer: "C" });
    expect(rules.compareAnswer(item, "MCQ", "")).toEqual({ status: "UNCHECKED" });
    expect(rules.compareAnswer({ answer: { accepted: ["0.5", "1/2"] } }, "FILL_IN", "1/2.")).toMatchObject({ status: "AGREE" });
    expect(rules.compareAnswer({}, "ESSAY", "x")).toEqual({ status: "NOT_OBJECTIVE" });
  });

  it("section totals count only the best N for 'answer any N'", () => {
    const qs = [{ marks: 15 }, { marks: 10 }, { marks: 15 }];
    expect(rules.sectionMaxMarks({}, qs)).toBe(40);
    expect(rules.sectionMaxMarks({ answerAny: 2 }, qs)).toBe(30);
    expect(rules.paperTotalMarks([{}, { answerAny: 2 }], { 1: [{ marks: 1 }, { marks: 1 }], 2: qs })).toBe(32);
  });

  it("level bands from the class name, then the section", () => {
    expect(rules.levelBandFor("Basic 2")).toBe("B1-B3");
    expect(rules.levelBandFor("Class 5")).toBe("B4-B6");
    expect(rules.levelBandFor("JHS 1")).toBe("JHS");
    expect(rules.levelBandFor("Basic 8")).toBe("JHS");
    expect(rules.levelBandFor("Nursery 1")).toBe("KG");
    expect(rules.levelBandFor("Gold", "JHS")).toBe("JHS");
  });

  it("the spec: sections 1-20 items, at most 6, and topics", () => {
    expect(() => rules.normaliseSpec({ sections: [{ ...MCQ_SECTION, count: 21 }] })).toThrow(/1 to 20/);
    expect(() => rules.normaliseSpec({ sections: Array(7).fill(MCQ_SECTION) })).toThrow(/At most 6/);
    expect(() => rules.normaliseSpec({ sections: [] })).toThrow(/at least one section/);
    const spec = rules.normaliseSpec({ topics: "Fractions, Decimals\nFractions", sections: [{ ...MCQ_SECTION, title: "" }] });
    expect(spec.topics).toEqual(["Fractions", "Decimals"]);
    expect(spec.sections[0]).toMatchObject({ title: "Section A", type: "MCQ", count: 2, marksEach: 1, difficulty: "MIXED", accepted: false });
  });
});

// ---------------------------------------------------------------- scope and ownership

describe("teacher scope and ownership", () => {
  it("creates a paper for a class + subject in scope, this term", async () => {
    const res = await create();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "Mathematics: Basic 5",
      status: "DRAFT",
      teacher: { teacherId: 3, name: "Ama Owusu" },
      subject: { subjectId: 10, name: "Mathematics" },
      class: { classId: 5, name: "Basic 5" },
      term: { termId: 1, name: "Term 1" },
      questionCount: 0,
      canFinalise: false,
    });
    expect(db.QuestionPaper.rows[0]).toMatchObject({ teacherId: 3, termId: 1 });
  });

  it("refuses a subject that isn't the teacher's (403), a KG class (400) and no open term (409)", async () => {
    expect((await create({ subjectId: 11 })).status).toBe(403); // Science is the class teacher's
    expect((await create({ classId: 6 })).status).toBe(400);
    db.Term.rows[0].active = false;
    expect((await create()).status).toBe(409);
  });

  it("the class teacher may write papers for subjects nobody else is assigned", async () => {
    const res = await as(T.t4).post("/teacher/papers", { classId: 5, subjectId: 11, sections: [MCQ_SECTION] });
    expect(res.status).toBe(200);
  });

  it("another teacher's paper is a 404, for reading and for writing", async () => {
    const id = (await create()).body.paperId;
    const other = as(T.t4);
    expect((await other.get(`/teacher/papers/${id}`)).status).toBe(404);
    expect((await other.patch(`/teacher/papers/${id}`, { title: "Mine now" })).status).toBe(404);
    expect((await other.post(`/teacher/papers/${id}/sections/1/questions`, handMcq())).status).toBe(404);
    expect((await other.post(`/teacher/papers/${id}/status`, { status: "FINAL" })).status).toBe(404);
    expect((await other.del(`/teacher/papers/${id}`)).status).toBe(404);
    expect((await other.get("/teacher/papers")).body.papers).toEqual([]);
    expect((await as(T.t3).get("/teacher/papers")).body.papers).toHaveLength(1);
  });

  it("only portal teachers reach /teacher/papers", async () => {
    expect((await as(T.admin).get("/teacher/papers")).status).toBe(403);
    expect((await as(T.pupil).get("/teacher/papers")).status).toBe(403);
    expect((await request(app).get("/teacher/papers")).status).toBe(401);
  });
});

// ---------------------------------------------------------------- by hand, AI off

describe("writing a paper by hand with AI switched off", () => {
  it("add, edit, reorder, delete, accept and mark FINAL without any AI", async () => {
    const t = as(T.t3);
    const id = (await create({ sections: [MCQ_SECTION, ESSAY_SECTION] })).body.paperId;
    expect((await t.post(`/teacher/papers/${id}/sections/1/generate`)).body.code).toBe("AI_DISABLED");

    let res = await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq());
    expect(res.status).toBe(200);
    res = await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq("What is a quarter of 8 cedis?"));
    // Same text twice is refused.
    expect((await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq())).status).toBe(409);
    // A bad MCQ is refused with the reason.
    const bad = await t.post(`/teacher/papers/${id}/sections/1/questions`, { stem: "Odd one?", options: ["a", "b", "c"], answer: { key: "A" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/exactly 4/);
    // Written: scheme must add up (10 marks).
    expect(
      (await t.post(`/teacher/papers/${id}/sections/2/questions`, { stem: "Describe a market day.", markingScheme: [{ point: "Setting", marks: 3 }] })).status
    ).toBe(400);
    res = await t.post(`/teacher/papers/${id}/sections/2/questions`, {
      stem: "Describe a market day.",
      markingScheme: [{ point: "Setting", marks: 4 }, { point: "Prices in cedis", marks: 6 }],
    });
    expect(res.body.totalMarks).toBe(12);
    expect(res.body.sections[0].questions.map((q) => [q.number, q.origin])).toEqual([[1, "TEACHER"], [2, "TEACHER"]]);
    expect(res.body.sections[1].questions[0].number).toBe(3);

    const [q1, q2] = res.body.sections[0].questions;
    res = await t.put(`/teacher/papers/${id}/sections/1/order`, { questionIds: [q2.questionId, q1.questionId] });
    expect(res.body.sections[0].questions.map((q) => q.questionId)).toEqual([q2.questionId, q1.questionId]);
    expect((await t.put(`/teacher/papers/${id}/sections/1/order`, { questionIds: [q1.questionId] })).status).toBe(409);

    res = await t.patch(`/teacher/papers/${id}/questions/${q1.questionId}`, { marks: 2 });
    expect(res.body.sections[0].totalMarks).toBe(3);
    expect(res.body.sections[0].questions.find((q) => q.questionId === q1.questionId).origin).toBe("TEACHER");

    res = await t.del(`/teacher/papers/${id}/questions/${q2.questionId}`);
    expect(res.body.sections[0].questions.map((q) => q.position)).toEqual([1]);

    // Not ready: sections not accepted yet.
    res = await t.post(`/teacher/papers/${id}/status`, { status: "FINAL" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Accept Section A/);
    await t.post(`/teacher/papers/${id}/sections/1/accept`);
    res = await t.post(`/teacher/papers/${id}/sections/2/accept`);
    expect(res.body.canFinalise).toBe(true);
    res = await t.post(`/teacher/papers/${id}/status`, { status: "FINAL" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FINAL");
    expect(db.AiUsageLog.rows).toHaveLength(0); // no model call anywhere
  });

  it("a section with no questions can't be accepted", async () => {
    const id = (await create()).body.paperId;
    expect((await as(T.t3).post(`/teacher/papers/${id}/sections/1/accept`)).status).toBe(400);
  });

  it("removing a section moves later sections' questions up", async () => {
    const t = as(T.t3);
    const id = (await create({ sections: [MCQ_SECTION, ESSAY_SECTION] })).body.paperId;
    await t.post(`/teacher/papers/${id}/sections/2/questions`, { stem: "Describe a market day." });
    const res = await t.del(`/teacher/papers/${id}/sections/1`);
    expect(res.status).toBe(200);
    expect(res.body.sections).toHaveLength(1);
    expect(res.body.sections[0]).toMatchObject({ type: "ESSAY", number: 1 });
    expect(res.body.sections[0].questions[0].stem).toBe("Describe a market day.");
    expect((await t.del(`/teacher/papers/${id}/sections/1`)).status).toBe(400); // the last one stays
  });

  it("a section's type can't change while it has questions", async () => {
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq());
    expect((await t.patch(`/teacher/papers/${id}`, { sections: [{ ...MCQ_SECTION, type: "ESSAY" }] })).status).toBe(409);
    const ok = await t.patch(`/teacher/papers/${id}`, { sections: [{ ...MCQ_SECTION, count: 5 }, ESSAY_SECTION], title: "Test 1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: "Test 1", sections: [{ count: 5 }, { type: "ESSAY" }] });
  });
});

// ---------------------------------------------------------------- FINAL

describe("a FINAL paper is read-only", () => {
  const finalPaper = async () => {
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq());
    await t.post(`/teacher/papers/${id}/sections/1/accept`);
    expect((await t.post(`/teacher/papers/${id}/status`, { status: "FINAL" })).body.status).toBe("FINAL");
    return id;
  };

  it("refuses every change with 409 until its teacher reopens it", async () => {
    const t = as(T.t3);
    const id = await finalPaper();
    const qid = db.Question.rows[0].questionId;
    expect((await t.patch(`/teacher/papers/${id}`, { title: "x" })).status).toBe(409);
    expect((await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq("Another one?"))).status).toBe(409);
    expect((await t.patch(`/teacher/papers/${id}/questions/${qid}`, { stem: "Changed?" })).status).toBe(409);
    expect((await t.del(`/teacher/papers/${id}/questions/${qid}`)).status).toBe(409);
    expect((await t.put(`/teacher/papers/${id}/sections/1/order`, { questionIds: [qid] })).status).toBe(409);
    expect((await t.del(`/teacher/papers/${id}`)).status).toBe(409);
    expect((await t.post(`/teacher/papers/${id}/sections/1/accept`)).status).toBe(409);
    aiOn();
    expect((await t.post(`/teacher/papers/${id}/sections/1/generate`)).status).toBe(409);
    // Reading is fine.
    expect((await t.get(`/teacher/papers/${id}`)).status).toBe(200);
    // Another teacher can't reopen it.
    expect((await as(T.t4).post(`/teacher/papers/${id}/status`, { status: "DRAFT" })).status).toBe(404);
    // The owner can.
    const res = await t.post(`/teacher/papers/${id}/status`, { status: "DRAFT" });
    expect(res.body.status).toBe("DRAFT");
    expect((await t.patch(`/teacher/papers/${id}/questions/${qid}`, { stem: "Changed now?" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------- AI

const goodSection = { json: { items: [mcq("What is half of a whole?", "B"), mcq("Which is a quarter?", "A", ["1/4", "1/3", "2/3", "1"])] } };

describe("AI: generate a section", () => {
  it("validates, runs the blind checker and stores a draft; accept makes the questions", async () => {
    aiOn();
    const provider = createFakeProvider([
      goodSection,
      { json: { answers: [{ position: 1, answer: "B" }, { position: 2, answer: "C" }] } }, // disagrees with item 2
    ]);
    setAiProviderForTests(provider);
    const t = as(T.t3);
    const id = (await create()).body.paperId;

    let res = await t.post(`/teacher/papers/${id}/sections/1/generate`, { note: "Use market prices" });
    expect(res.status).toBe(200);
    const draft = res.body.sections[0].draft;
    expect(draft).toMatchObject({ status: "PENDING", flaggedCount: 1 });
    expect(draft.items.map((i) => i.check)).toEqual([
      { status: "AGREE", checkerAnswer: "B" },
      { status: "DISAGREE", checkerAnswer: "C" },
    ]);
    expect(res.body.sections[0].questions).toEqual([]); // nothing on the paper yet
    expect(res.body.finaliseBlockers).toContainEqual(expect.stringMatching(/AI draft waiting/));

    // The checker never sees the key.
    const checkReq = provider.calls[1];
    expect(checkReq.messages[0].content).toMatch(/What is half of a whole/);
    expect(checkReq.messages[0].content).not.toMatch(/"answer"/);
    expect(provider.calls[0].messages[0].content).toMatch(/Use market prices/);
    expect(provider.calls[0].messages[0].content).toMatch(/B4-B6/);
    expect(db.AiUsageLog.rows.map((r) => [r.feature, r.status, r.promptVersion])).toEqual([
      ["PAPERS", "OK", "questionSection@1.0.0"],
      ["PAPERS", "OK", "questionCheck@1.0.0"],
    ]);

    // Edit item 1 in the draft, then accept the section.
    const items = draft.items.map((i, n) => (n === 0 ? { ...i, stem: "What is one half of a whole?" } : i));
    res = await t.put(`/teacher/papers/${id}/drafts/${draft.suggestionId}`, { items });
    expect(res.body.sections[0].draft).toMatchObject({ status: "EDITED" });
    expect(res.body.sections[0].draft.items[0].edited).toBe(true);
    expect(res.body.sections[0].draft.items[1].edited).toBeUndefined();

    res = await t.post(`/teacher/papers/${id}/sections/1/accept`);
    expect(res.status).toBe(200);
    expect(res.body.sections[0].draft).toBeNull();
    expect(res.body.sections[0].accepted).toBe(true);
    expect(res.body.sections[0].questions.map((q) => [q.stem, q.origin, q.checkerDisagrees, q.checkerAnswer])).toEqual([
      ["What is one half of a whole?", "AI_EDITED", false, null],
      ["Which is a quarter?", "AI", true, "C"],
    ]);
    expect(res.body.flaggedCount).toBe(1);
    expect(db.AiSuggestion.rows[0].status).toBe("ACCEPTED");

    // Fixing the key by hand clears the flag; the question becomes AI_EDITED.
    const q2 = res.body.sections[0].questions[1];
    res = await t.patch(`/teacher/papers/${id}/questions/${q2.questionId}`, { answer: { key: "A" }, options: q2.options });
    expect(res.body.sections[0].questions[1]).toMatchObject({ origin: "AI", checkerDisagrees: true }); // nothing changed
    res = await t.patch(`/teacher/papers/${id}/questions/${q2.questionId}`, { answer: { key: "C" } });
    expect(res.body.sections[0].questions[1]).toMatchObject({ origin: "AI_EDITED", checkerDisagrees: false });
  });

  it("refuses bad model output: one retry with the reason, then a friendly 502", async () => {
    aiOn();
    const three = { json: { items: [{ ...mcq("Half?"), options: mcq("x").options.slice(0, 3) }, mcq("Quarter?")] } };
    let provider = createFakeProvider([three, goodSection, { json: { answers: [] } }]);
    setAiProviderForTests(provider);
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    let res = await t.post(`/teacher/papers/${id}/sections/1/generate`);
    expect(res.status).toBe(200);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1].messages.at(-1).content).toMatch(/3 options/);
    expect(res.body.sections[0].draft.items.every((i) => i.check.status === "UNCHECKED")).toBe(true); // checker said nothing

    provider = createFakeProvider([three, three]);
    setAiProviderForTests(provider);
    res = await t.post(`/teacher/papers/${id}/sections/1/generate`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("AI_FAILED");
    // The earlier draft is still there.
    expect((await t.get(`/teacher/papers/${id}`)).body.sections[0].draft.status).toBe("PENDING");
  });

  it("generating again replaces the open draft (one per section)", async () => {
    aiOn();
    setAiProviderForTests(createFakeProvider([goodSection, { json: { answers: [] } }, goodSection, { json: { answers: [] } }]));
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    await t.post(`/teacher/papers/${id}/sections/1/generate`);
    await t.post(`/teacher/papers/${id}/sections/1/generate`);
    expect(db.AiSuggestion.rows.map((r) => r.status)).toEqual(["REJECTED", "PENDING"]);
  });

  it("a checker failure leaves items unchecked instead of losing the section", async () => {
    aiOn();
    setAiProviderForTests(createFakeProvider([goodSection, { error: Object.assign(new Error("blocked"), { status: 400 }) }]));
    const id = (await create()).body.paperId;
    const res = await as(T.t3).post(`/teacher/papers/${id}/sections/1/generate`);
    expect(res.status).toBe(200);
    expect(res.body.sections[0].draft.items.map((i) => i.check.status)).toEqual(["UNCHECKED", "UNCHECKED"]);
  });

  it("regenerates one item only, checked, and marked regenerated", async () => {
    aiOn();
    const provider = createFakeProvider([
      goodSection,
      { json: { answers: [{ position: 1, answer: "B" }, { position: 2, answer: "A" }] } },
      { json: { items: [mcq("Which fraction is the largest?", "D", ["1/4", "1/3", "1/2", "3/4"])] } },
      { json: { answers: [{ position: 1, answer: "A" }] } },
    ]);
    setAiProviderForTests(provider);
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    const draft = (await t.post(`/teacher/papers/${id}/sections/1/generate`)).body.sections[0].draft;
    const [first, second] = draft.items;

    const res = await t.post(`/teacher/papers/${id}/drafts/${draft.suggestionId}/regenerate`, { key: second.key });
    expect(res.status).toBe(200);
    const items = res.body.sections[0].draft.items;
    expect(items[0]).toEqual(first);
    expect(items[1]).toMatchObject({ stem: "Which fraction is the largest?", regenerated: true, check: { status: "DISAGREE", checkerAnswer: "A" } });
    expect(items[1].key).not.toBe(second.key);
    // The model was told not to repeat what is already in the draft.
    expect(provider.calls[2].messages[0].content).toMatch(/avoidStems[\s\S]*What is half of a whole/);
    expect(provider.calls[2].messages[0].content).toMatch(/Write 1 MCQ/);
    expect((await t.post(`/teacher/papers/${id}/drafts/${draft.suggestionId}/regenerate`, { key: "nope" })).status).toBe(404);
    // Another teacher can't touch the draft.
    expect((await as(T.t4).post(`/teacher/papers/${id}/drafts/${draft.suggestionId}/regenerate`, { key: first.key })).status).toBe(404);
  });

  it("a draft with an invalid edit is refused; discarding writes nothing", async () => {
    aiOn();
    setAiProviderForTests(createFakeProvider([goodSection, { json: { answers: [] } }]));
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    const draft = (await t.post(`/teacher/papers/${id}/sections/1/generate`)).body.sections[0].draft;
    const bad = draft.items.map((i, n) => (n === 0 ? { ...i, answer: { key: "Z" } } : i));
    expect((await t.put(`/teacher/papers/${id}/drafts/${draft.suggestionId}`, { items: bad })).status).toBe(400);
    expect((await t.put(`/teacher/papers/${id}/drafts/${draft.suggestionId}`, { items: [{ ...draft.items[0], key: "forged" }] })).status).toBe(400);
    const res = await t.post(`/teacher/papers/${id}/drafts/${draft.suggestionId}/discard`);
    expect(res.body.sections[0].draft).toBeNull();
    expect(db.Question.rows).toHaveLength(0);
  });

  it("drafts can still be reviewed and accepted after AI is switched off", async () => {
    aiOn();
    setAiProviderForTests(createFakeProvider([goodSection, { json: { answers: [] } }]));
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    await t.post(`/teacher/papers/${id}/sections/1/generate`);
    db.AiSettings.rows[0].enabled = false;
    clearAiSettingsCache();
    const res = await t.post(`/teacher/papers/${id}/sections/1/accept`);
    expect(res.status).toBe(200);
    expect(res.body.questionCount).toBe(2);
  });

  it("over the monthly cap: generation is refused with 429, everything else keeps working", async () => {
    aiOn();
    const provider = createFakeProvider([goodSection]);
    setAiProviderForTests(provider);
    db.AiUsageLog.sum.mockImplementation(async () => 100);
    const t = as(T.t3);
    const id = (await create()).body.paperId;
    const res = await t.post(`/teacher/papers/${id}/sections/1/generate`);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("AI_QUOTA");
    expect(provider.calls).toHaveLength(0);
    expect((await t.get("/teacher/papers")).status).toBe(200);
    expect((await t.post(`/teacher/papers/${id}/sections/1/questions`, handMcq())).status).toBe(200);
  });

  it("an office user can't accept a teacher's paper draft through /ai/suggestions", async () => {
    aiOn();
    setAiProviderForTests(createFakeProvider([goodSection, { json: { answers: [] } }]));
    const id = (await create()).body.paperId;
    const draft = (await as(T.t3).post(`/teacher/papers/${id}/sections/1/generate`)).body.sections[0].draft;
    const res = await as(T.admin).post(`/ai/suggestions/${draft.suggestionId}/accept`);
    expect(res.status).toBe(403);
    expect(db.Question.rows).toHaveLength(0);
    expect(db.AiSuggestion.rows[0].status).toBe("PENDING");
  });
});

// ---------------------------------------------------------------- head teacher

describe("the head teacher's view (office)", () => {
  it("the Administrator lists and views every paper; other roles can't", async () => {
    const t3 = as(T.t3);
    const a = (await create()).body.paperId;
    await t3.post(`/teacher/papers/${a}/sections/1/questions`, handMcq());
    await as(T.t4).post("/teacher/papers", { classId: 5, subjectId: 11, sections: [ESSAY_SECTION] });

    let res = await as(T.admin).get("/question-papers");
    expect(res.status).toBe(200);
    expect(res.body.papers.map((p) => [p.teacher.name, p.questionCount, p.totalMarks]).sort()).toEqual([
      ["Ama Owusu", 1, 1],
      ["Kofi Mensah", 0, 0],
    ]);
    res = await as(T.admin).get("/question-papers?teacherId=3&limit=10");
    expect(res.body).toMatchObject({ total: 1, page: 1 });

    res = await as(T.admin).get(`/question-papers/${a}`);
    expect(res.status).toBe(200);
    expect(res.body.sections[0].questions[0].answer).toEqual({ key: "B" });
    expect(res.body.sections[0].draft).toBeNull();

    expect((await as(T.accountant).get("/question-papers")).status).toBe(403);
    expect((await as(T.t3).get("/question-papers")).status).toBe(403);
    expect((await as(T.admin).get("/question-papers/999")).status).toBe(404);
  });
});
