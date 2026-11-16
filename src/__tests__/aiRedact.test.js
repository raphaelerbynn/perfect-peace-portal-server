// AI-0: nothing with contact data or credentials reaches the model.
import { redactForAi, redactText, redactedPaths } from "../services/ai/redact.js";
import { registerPrompt, renderPrompt, getPrompt, resetPromptRegistry, livePromptVersions } from "../services/ai/prompts/registry.js";
import { toneLines } from "../services/ai/prompts/base.js";

describe("redactText", () => {
  it.each([
    ["Call 024 233 2420 today", "Call [phone] today"],
    ["0242332420", "[phone]"],
    ["+233 24 233 2420", "[phone]"],
    ["233-24-233-2420", "[phone]"],
    ["020-123-4567", "[phone]"],
    ["Mum: +44 7700 900123", "Mum: [phone]"],
    ["write to parent.name@gmail.com please", "write to [email] please"],
    ["024 233 2420/024 315 4072", "[phone]/[phone]"],
  ])("%s", (input, out) => {
    expect(redactText(input)).toBe(out);
  });

  it.each([
    "Paid GH₵ 1,250.00 on 12/11/2026",
    "Index STU/1234 and PPS/2026/0001",
    "Score 87.5 out of 100, 2026 Term 3",
    "Owes 4500 cedis; 30 pupils in Class 4",
  ])("leaves %s alone", (s) => {
    expect(redactText(s)).toBe(s);
  });
});

describe("redactForAi", () => {
  const pupil = {
    studentId: 12,
    fName: "Ama",
    password: "$2b$10$hash",
    address: "House 4, Mempeasem",
    feesOwing: 350,
    parent: { fName: "Kofi", contact: "0244123456", contact1: "0201234567", email: "k@x.com", relationship: "Father", occupation: "Trader" },
    note: "Ring 0244 123 456 after 4",
    tokens: { inputTokens: 5 },
  };

  it("drops credential, contact and staff-private keys at any depth, scrubs strings, keeps the rest", () => {
    const out = redactForAi(pupil);
    expect(out).toEqual({
      studentId: 12,
      fName: "Ama",
      feesOwing: 350,
      parent: { fName: "Kofi", relationship: "Father", occupation: "Trader" },
      note: "Ring [phone] after 4",
      tokens: { inputTokens: 5 },
    });
    expect(JSON.stringify(out)).not.toMatch(/0244|k@x|hash|Mempeasem/);
    expect(pupil.parent.contact).toBe("0244123456"); // input untouched
  });

  it("covers the PP staff and login fields", () => {
    const staff = { teacherId: 3, fName: "Esi", phone: "0241112222", email: "e@s.com", ssnitNumber: "C1", tinNumber: "T", bank: "GCB", accountNumber: "1", references: "x", resetCode: "123456", refreshToken: "r", pin: "1234", staffPosition: "Teacher" };
    expect(redactForAi(staff)).toEqual({ teacherId: 3, fName: "Esi", staffPosition: "Teacher" });
  });

  it("walks arrays, Sequelize-like instances, and survives cycles", () => {
    class Row {
      constructor() {
        this.dataValues = {};
      }
      get() {
        return { fName: "A", email: "a@b.co" };
      }
    }
    const inst = new Row();
    const cyc = { a: 1 };
    cyc.self = cyc;
    expect(redactForAi([inst, { phone: "0241112222", n: 1 }])).toEqual([{ fName: "A" }, { n: 1 }]);
    expect(redactForAi(cyc)).toEqual({ a: 1 });
    expect(redactForAi(new Date(0))).toEqual(new Date(0));
  });

  it("redactedPaths names what goes", () => {
    expect(redactedPaths(pupil)).toEqual(["password", "address", "parent.contact", "parent.contact1", "parent.email"]);
  });
});

describe("prompt registry", () => {
  beforeEach(() => resetPromptRegistry());

  it("renders prefix + tail with key@version", () => {
    const p = registerPrompt({ key: "t", version: "1.2.0", prefix: (v) => `School ${v.name}`, tail: (v) => `Q: ${v.q}` });
    expect(renderPrompt("t", { name: "PP", q: "hi" })).toEqual({ key: "t", version: "1.2.0", promptVersion: "t@1.2.0", system: "School PP", user: "Q: hi" });
    expect(registerPrompt(p)).toBe(p); // same object twice is fine
    expect(livePromptVersions()).toEqual({ t: "1.2.0" });
  });

  it("refuses a missing version, a duplicate key and an unknown key", () => {
    expect(() => registerPrompt({ key: "x", prefix: () => "", tail: () => "" })).toThrow(/version/);
    registerPrompt({ key: "x", version: "1", prefix: () => "", tail: () => "" });
    expect(() => registerPrompt({ key: "x", version: "2", prefix: () => "", tail: () => "" })).toThrow(/already registered/);
    expect(() => getPrompt("nope")).toThrow(/No prompt registered for "nope"/);
  });

  it("tone lines follow the settings", () => {
    expect(toneLines({}).join(" ")).toMatch(/formal.*British.*Dear Parent\/Guardian/);
    expect(toneLines({ formal: false, britishSpelling: false, salutation: "" }).join(" ")).toMatch(/warm.*American/);
  });
});
