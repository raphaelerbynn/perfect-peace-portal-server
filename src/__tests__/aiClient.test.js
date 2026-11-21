// AI-0: the model client with a fake provider (no network): error
// classification, retry with backoff for RATE_LIMIT / TIMEOUT, no retry for
// SAFETY_BLOCK / AUTH, the timeout, JSON schema check + one MALFORMED retry,
// tool calls, streaming, and the Gemini request/response translation.
import { createAiClient, classifyError, backoffDelayMs, parseJsonAnswer } from "../services/ai/client.js";
import { AiProviderError } from "../services/ai/errors.js";
import { createFakeProvider } from "../services/ai/providers/fake.js";
import { normalise, toContents, toGeminiTools, systemInstructionFor } from "../services/ai/providers/gemini.js";
import { checkAgainstSchema } from "../services/ai/schemaCheck.js";

const cfg = { maxRetries: 2, retryBaseDelayMs: 100, timeoutMs: 5000 };
const make = (script, extra = {}) => {
  const provider = createFakeProvider(script);
  const sleep = jest.fn(async () => {});
  const client = createAiClient({ provider, config: { ...cfg, ...extra }, sleep, random: () => 1 });
  return { client, provider, sleep };
};
const err = (props, message = "boom") => ({ error: Object.assign(new Error(message), props) });
const req = { model: "gemini-3.1-flash-lite", system: "sys", messages: [{ role: "user", content: "hi" }] };

describe("classifyError", () => {
  it.each([
    [{ status: 429 }, "x", "RATE_LIMIT"],
    [{ status: 503 }, "x", "RATE_LIMIT"],
    [{}, "RESOURCE_EXHAUSTED: quota", "RATE_LIMIT"],
    [{ status: 401 }, "x", "AUTH"],
    [{ status: 403 }, "x", "AUTH"],
    [{}, "API key not valid", "AUTH"],
    [{ status: 504 }, "x", "TIMEOUT"],
    [{}, "DEADLINE_EXCEEDED", "TIMEOUT"],
    [{ name: "AbortError" }, "x", "TIMEOUT"],
    [{ status: 400 }, "bad request", "PROVIDER_ERROR"],
    [{}, "socket hang up", "UNKNOWN"],
  ])("%j %s -> %s", (props, message, expected) => {
    expect(classifyError(Object.assign(new Error(message), props)).errorClass).toBe(expected);
  });

  it("a fired deadline is a TIMEOUT whatever the message; an AiProviderError passes through", () => {
    expect(classifyError(new Error("anything"), { deadlineFired: true }).errorClass).toBe("TIMEOUT");
    const e = new AiProviderError("SAFETY_BLOCK", "x");
    expect(classifyError(e)).toBe(e);
  });

  it("backoff doubles per attempt", () => {
    expect([0, 1, 2].map((a) => backoffDelayMs(a, 100, () => 1))).toEqual([100, 200, 400]);
    expect(backoffDelayMs(0, 100, () => 0)).toBe(50); // jitter: 50-100%
  });
});

describe("retries", () => {
  it("RATE_LIMIT is retried with backoff and then succeeds", async () => {
    const { client, provider, sleep } = make([err({ status: 429 }), err({ status: 503 }), { text: "ok" }]);
    const res = await client.generateText(req);
    expect(res.text).toBe("ok");
    expect(provider.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("gives up after maxRetries with the classified error", async () => {
    const { client, provider } = make([err({ status: 429 })]);
    await expect(client.generateText(req)).rejects.toMatchObject({ errorClass: "RATE_LIMIT" });
    expect(provider.calls).toHaveLength(3); // 1 + 2 retries
  });

  it.each([
    ["AUTH", err({ status: 401 })],
    ["PROVIDER_ERROR", err({ status: 400 })],
  ])("%s is never retried", async (cls, step) => {
    const { client, provider } = make([step, { text: "never" }]);
    await expect(client.generateText(req)).rejects.toMatchObject({ errorClass: cls });
    expect(provider.calls).toHaveLength(1);
  });

  it("a safety block (prompt or answer) is SAFETY_BLOCK and not retried", async () => {
    const a = make([{ blockReason: "SAFETY" }, { text: "never" }]);
    await expect(a.client.generateText(req)).rejects.toMatchObject({ errorClass: "SAFETY_BLOCK" });
    expect(a.provider.calls).toHaveLength(1);
    const b = make([{ text: "", finishReason: "PROHIBITED_CONTENT" }]);
    await expect(b.client.generateText(req)).rejects.toMatchObject({ errorClass: "SAFETY_BLOCK" });
  });

  it("a call that outlives the timeout is a TIMEOUT (and is retried)", async () => {
    jest.useFakeTimers();
    try {
      const slow = () => ({ text: "late" });
      const provider = { id: "slow", calls: 0, generate: jest.fn(() => new Promise(() => {})), stream: jest.fn() };
      provider.generate.mockImplementationOnce(() => new Promise(() => {})).mockImplementationOnce(async () => ({ ...slow(), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }));
      const client = createAiClient({ provider, config: { ...cfg, timeoutMs: 1000 }, sleep: async () => {} });
      const p = client.generateText(req);
      await jest.advanceTimersByTimeAsync(1001);
      await expect(p).resolves.toMatchObject({ text: "late" });
      expect(provider.generate).toHaveBeenCalledTimes(2);
      // the signal handed to the provider was aborted on the first attempt
      expect(provider.generate.mock.calls[0][1].aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("generateJson", () => {
  const schema = {
    type: "object",
    required: ["title", "items"],
    properties: { title: { type: "string" }, items: { type: "array", minItems: 1, items: { type: "string" } } },
  };

  it("sends the schema as responseJsonSchema and returns parsed data", async () => {
    const { client, provider } = make([{ json: { title: "T", items: ["a"] } }]);
    const res = await client.generateJson({ ...req, schema });
    expect(res.data).toEqual({ title: "T", items: ["a"] });
    expect(res.attempts).toBe(1);
    expect(provider.calls[0].json).toEqual({ schema });
  });

  it("retries ONCE on a malformed answer, telling the model what was wrong, and adds up both calls' tokens", async () => {
    const { client, provider } = make([{ text: "not json" }, { json: { title: "T", items: ["a"] } }]);
    const res = await client.generateJson({ ...req, schema });
    expect(res.attempts).toBe(2);
    expect(res.usage).toMatchObject({ inputTokens: 200, outputTokens: 100 });
    const second = provider.calls[1].messages;
    expect(second.at(-1).content).toMatch(/not valid JSON/);
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: "not json" });
  });

  it("two malformed answers -> MALFORMED_OUTPUT carrying the tokens spent", async () => {
    const { client, provider } = make([{ json: { title: "T" } }, { json: { title: 3, items: [] } }]);
    const e = await client.generateJson({ ...req, schema }).catch((x) => x);
    expect(e).toBeInstanceOf(AiProviderError);
    expect(e.errorClass).toBe("MALFORMED_OUTPUT");
    expect(e.usage.inputTokens).toBe(200);
    expect(provider.calls).toHaveLength(2);
  });

  it("the feature's own validate() can reject an answer (counts as malformed)", async () => {
    const validate = jest.fn((d) => (d.title.includes("?") ? "invented a date" : null));
    const { client } = make([{ json: { title: "?", items: ["a"] } }, { json: { title: "ok", items: ["a"] } }]);
    const res = await client.generateJson({ ...req, schema, validate });
    expect(res.data.title).toBe("ok");
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("code fences around JSON are tolerated", () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```', { type: "object" }).data).toEqual({ a: 1 });
  });
});

describe("tools and streaming", () => {
  it("chat returns tool calls with ids", async () => {
    const { client, provider } = make([{ toolCalls: [{ name: "count_pupils", args: { classId: 3 } }] }]);
    const res = await client.chat({ ...req, tools: [{ name: "count_pupils", description: "d", parameters: { type: "object" } }] });
    expect(res.toolCalls).toEqual([{ id: "call_0_count_pupils", name: "count_pupils", args: { classId: 3 } }]);
    expect(provider.calls[0].tools[0].name).toBe("count_pupils");
  });

  it("stream yields text chunks, then usage, then done", async () => {
    const { client } = make([{ text: "Hello there" }]);
    const chunks = [];
    for await (const c of client.stream(req)) chunks.push(c);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.text).join("")).toBe("Hello there");
    expect(chunks.at(-2)).toMatchObject({ type: "usage", usage: { inputTokens: 100 } });
    expect(chunks.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("Gemini translation (no SDK call)", () => {
  it("folds system messages into the instruction and maps roles, tool calls and results", () => {
    const messages = [
      { role: "system", content: "extra rule" },
      { role: "user", content: "How many?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "count", args: {}, providerSignature: "sig" }] },
      { role: "tool", content: "", toolResults: [{ callId: "c1", name: "count", result: 5, truncated: true }] },
    ];
    expect(systemInstructionFor("base", messages)).toBe("base\n\nextra rule");
    expect(toContents(messages)).toEqual([
      { role: "user", parts: [{ text: "How many?" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "count", args: {} }, thoughtSignature: "sig" }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "count", response: { output: 5, truncated: true } } }] },
    ]);
    expect(toGeminiTools([{ name: "n", description: "d", parameters: { type: "object" } }])).toEqual([
      { functionDeclarations: [{ name: "n", description: "d", parametersJsonSchema: { type: "object" } }] },
    ]);
  });

  it("normalises a response: text without thoughts, tool calls, usage (cached split out, thoughts billed)", () => {
    const res = normalise(
      {
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: "Answer" }, { functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "s" }] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, toolUsePromptTokenCount: 10, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
        modelVersion: "gemini-3.1-flash-lite-001",
      },
      "gemini-3.1-flash-lite"
    );
    expect(res.text).toBe("Answer");
    expect(res.toolCalls).toEqual([{ id: "call_0_f", name: "f", args: { a: 1 }, providerSignature: "s" }]);
    expect(res.usage).toEqual({ inputTokens: 610, cachedTokens: 400, outputTokens: 70, model: "gemini-3.1-flash-lite-001" });
  });
});

describe("checkAgainstSchema", () => {
  it.each([
    [{ type: "object", required: ["a"] }, {}, /\$\.a is required/],
    [{ type: "string", enum: ["x"] }, "y", /allowed values/],
    [{ type: "array", items: { type: "integer" } }, [1, 1.5], /\$\[1\] should be integer/],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, 3, /none of the allowed/],
    [{ type: "string", maxLength: 3 }, "abcd", /longer than 3/],
  ])("%j rejects %j", (schema, value, re) => {
    expect(checkAgainstSchema(value, schema)).toMatch(re);
  });
  it("accepts a match and ignores $ref", () => {
    expect(checkAgainstSchema({ a: [1] }, { type: "object", properties: { a: { type: "array", items: { type: "number" } } } })).toBeNull();
    expect(checkAgainstSchema(1, { $ref: "#/x" })).toBeNull();
  });
});
