// AI-0: the model client (ported from SchoolPro's gemini.provider.ts, with the
// provider split out so tests and AI-off mode never touch the network).
//
// UNMETERED. Feature code should call services/ai/run.js (runJson / runText /
// runChat / streamText / runToolLoop), which checks the switches and the
// budget, redacts, and logs usage around these calls.
//
//   const client = createAiClient({ provider, sleep });   // tests: fake provider
//   const client = getAiClient();                          // the app's client
//
//   client.generateText({ model, system, messages })                 -> { text, usage }
//   client.generateJson({ model, system, messages, schema, validate }) -> { data, usage, attempts }
//   client.chat({ model, system, messages, tools })                  -> { text, toolCalls, usage, finishReason }
//   client.stream({ model, system, messages, tools })                -> async iterable of
//       { type: "text", text } | { type: "tool_call", call } | { type: "usage", usage } | { type: "done", finishReason }
//
// Every failure is an AiProviderError with an errorClass:
//   RATE_LIMIT / TIMEOUT -> retried with exponential backoff + jitter (maxRetries)
//   MALFORMED_OUTPUT     -> generateJson retries ONCE with a correction note
//   SAFETY_BLOCK / AUTH  -> never retried
// Each attempt has its own timeout (AI_REQUEST_TIMEOUT_MS).
import { aiConfig } from "./config.js";
import { AiProviderError } from "./errors.js";
import { checkAgainstSchema } from "./schemaCheck.js";
import { createFakeProvider } from "./providers/fake.js";
import { createGeminiProvider } from "./providers/gemini.js";

const SAFETY_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "RECITATION"]);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ZERO_USAGE = Object.freeze({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });

export const addUsage = (a, b) => ({
  inputTokens: (a?.inputTokens || 0) + (b?.inputTokens || 0),
  cachedTokens: (a?.cachedTokens || 0) + (b?.cachedTokens || 0),
  outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
  model: b?.model || a?.model,
});

/** Exponential backoff with jitter (a class-wide burst must not come back in step). */
export const backoffDelayMs = (attempt, baseDelayMs, random = Math.random) =>
  Math.round(baseDelayMs * 2 ** attempt * (0.5 + random() * 0.5));

const httpStatusOf = (err) => {
  for (const c of [err?.status, err?.code, err?.error?.code]) if (typeof c === "number" && Number.isFinite(c)) return c;
  return undefined;
};

/**
 * Raw SDK / network error -> AiProviderError. Read structurally (status,
 * message), never with instanceof, so a mocked SDK classifies the same way.
 */
export const classifyError = (raw, { deadlineFired = false } = {}) => {
  if (raw instanceof AiProviderError) return raw;
  const message = typeof raw?.message === "string" ? raw.message : String(raw);
  if (deadlineFired) return new AiProviderError("TIMEOUT", `No answer within the time limit: ${message}`, { cause: raw });
  if (raw?.name === "AbortError" || /\babort/i.test(message)) {
    return new AiProviderError("TIMEOUT", `The call was aborted: ${message}`, { cause: raw });
  }
  const status = httpStatusOf(raw);
  const haystack = `${message} ${String(raw?.error?.status ?? "")} ${typeof raw?.status === "string" ? raw.status : ""}`;
  let errorClass;
  // 503 = model overloaded: capacity, treated like a rate limit (retried).
  if (status === 429 || status === 503 || /RESOURCE_EXHAUSTED|rate.?limit|quota|UNAVAILABLE|overloaded|high demand/i.test(haystack)) {
    errorClass = "RATE_LIMIT";
  } else if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED|API key/i.test(haystack)) {
    errorClass = "AUTH";
  } else if (status === 408 || status === 504 || /DEADLINE_EXCEEDED|timed? ?out|ETIMEDOUT/i.test(haystack)) {
    errorClass = "TIMEOUT";
  } else if (status !== undefined) {
    errorClass = "PROVIDER_ERROR";
  } else {
    errorClass = "UNKNOWN";
  }
  return new AiProviderError(errorClass, `AI call failed: ${message}`, { cause: raw, status });
};

/** Refuse a 200 that isn't an answer (safety blocks arrive as empty candidates). */
export const assertUsable = (res) => {
  if (res?.blockReason && res.blockReason !== "BLOCKED_REASON_UNSPECIFIED") {
    throw new AiProviderError("SAFETY_BLOCK", `The prompt was blocked (${res.blockReason})`, { usage: res.usage });
  }
  if (res?.finishReason && SAFETY_FINISH_REASONS.has(res.finishReason)) {
    throw new AiProviderError("SAFETY_BLOCK", `The answer was blocked (${res.finishReason})`, { usage: res.usage });
  }
  if (res?.finishReason === "MALFORMED_FUNCTION_CALL" || res?.finishReason === "UNEXPECTED_TOOL_CALL") {
    throw new AiProviderError("MALFORMED_OUTPUT", `The model produced an unusable tool call (${res.finishReason})`, { usage: res.usage });
  }
};

/** JSON text -> { data } or { problem } (parse, schema, then the caller's own check). */
export const parseJsonAnswer = (text, schema, validate) => {
  const trimmed = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!trimmed) return { problem: "the answer was empty" };
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { problem: "the answer was not valid JSON" };
  }
  const schemaProblem = checkAgainstSchema(data, schema, "$");
  if (schemaProblem) return { problem: schemaProblem };
  if (validate) {
    const own = validate(data);
    if (own) return { problem: typeof own === "string" ? own : "the answer failed the feature's check" };
  }
  return { data };
};

const MALFORMED_ATTEMPTS = 2; // the first try + one retry

export const createAiClient = ({ provider, config = aiConfig, sleep = realSleep, random = Math.random } = {}) => {
  const cfg = () => (typeof config === "function" ? config() : config);
  const getProvider = () => (typeof provider === "function" ? provider() : provider);

  // One attempt under its own deadline, retried for RATE_LIMIT / TIMEOUT.
  // Usage from failed attempts is carried on the error, so failures still cost.
  const callWithRetry = async (fn, { timeoutMs, signal } = {}) => {
    const { maxRetries, retryBaseDelayMs, timeoutMs: defaultTimeout } = cfg();
    const limit = timeoutMs > 0 ? timeoutMs : defaultTimeout;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      let deadlineFired = false;
      let callerAborted = false;
      const timer = setTimeout(() => {
        deadlineFired = true;
        controller.abort();
      }, limit);
      timer.unref?.();
      const onAbort = () => {
        callerAborted = true;
        controller.abort();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.("abort", onAbort);
      try {
        // Race the deadline as well: a provider that ignores the signal must
        // still not hold the request open past the limit.
        const timeout = new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
        return await Promise.race([fn(controller.signal), timeout]);
      } catch (raw) {
        const error = classifyError(raw, { deadlineFired });
        if (callerAborted || attempt >= maxRetries || !error.retryable) throw error;
        await sleep(backoffDelayMs(attempt, retryBaseDelayMs, random));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }
    }
  };

  const generate = async (req) => {
    const res = await callWithRetry((signal) => getProvider().generate(req, signal), req);
    assertUsable(res);
    return res;
  };

  return {
    async generateText(req) {
      const res = await generate(req);
      return { text: res.text, usage: res.usage, finishReason: res.finishReason };
    },

    async chat(req) {
      const res = await generate(req);
      return { text: res.text, toolCalls: res.toolCalls || [], usage: res.usage, finishReason: res.finishReason };
    },

    /**
     * Structured output. `schema` (JSON Schema) is sent as responseJsonSchema
     * AND checked here; `validate(data)` may return a problem string for
     * feature rules (e.g. "a date nobody supplied"). One retry on a bad answer,
     * telling the model what was wrong.
     */
    async generateJson({ schema, validate, ...req }) {
      let usage = { ...ZERO_USAGE };
      let messages = req.messages || [];
      let lastProblem = null;
      for (let attempt = 1; attempt <= MALFORMED_ATTEMPTS; attempt += 1) {
        let res;
        try {
          res = await generate({ ...req, messages, json: { schema } });
        } catch (error) {
          if (error instanceof AiProviderError) error.usage = addUsage(usage, error.usage);
          throw error;
        }
        usage = addUsage(usage, res.usage);
        const { data, problem } = parseJsonAnswer(res.text, schema, validate);
        if (!problem) return { data, usage, attempts: attempt };
        lastProblem = problem;
        messages = [
          ...(req.messages || []),
          { role: "assistant", content: String(res.text || "").slice(0, 4000) },
          {
            role: "user",
            content: `Your last reply could not be used: ${problem}. Reply again with JSON only, matching the requested schema exactly.`,
          },
        ];
      }
      throw new AiProviderError("MALFORMED_OUTPUT", `The answer did not match the requested shape: ${lastProblem}`, { usage });
    },

    /**
     * Streaming (AI-1 can pipe this to SSE). Only the opening of the stream is
     * retried; once text has been sent a failure ends the stream with an error.
     */
    async *stream(req) {
      const iterable = await callWithRetry((signal) => getProvider().stream(req, signal), req);
      let usage;
      let finishReason;
      let index = 0;
      try {
        for await (const chunk of iterable) {
          assertUsable(chunk);
          if (chunk.text) yield { type: "text", text: chunk.text };
          for (const call of chunk.toolCalls || []) yield { type: "tool_call", call: { ...call, id: call.id || `call_${index++}_${call.name}` } };
          if (chunk.usage) usage = chunk.usage;
          if (chunk.finishReason) finishReason = chunk.finishReason;
        }
      } catch (raw) {
        throw classifyError(raw);
      }
      yield { type: "usage", usage: usage || { ...ZERO_USAGE, model: req.model } };
      yield { type: "done", finishReason };
    },
  };
};

// ---------------------------------------------------------------- the app's client
let override = null; // tests: setAiProviderForTests(createFakeProvider([...]))
let gemini = null;

/** The provider the app uses right now: the test override, the fake (dev), or Gemini. */
export const currentProvider = () => {
  if (override) return override;
  const cfg = aiConfig();
  if (cfg.fakeProvider) return createFakeProvider();
  if (!cfg.apiKey) {
    // Never reached through run.js (the gate refuses first), but a direct
    // caller gets a clear error instead of a network call.
    return {
      id: "none",
      generate: async () => {
        throw new AiProviderError("AUTH", "GEMINI_API_KEY is not set, so no AI call can be made");
      },
      stream: async () => {
        throw new AiProviderError("AUTH", "GEMINI_API_KEY is not set, so no AI call can be made");
      },
    };
  }
  if (!gemini || gemini.apiKey !== cfg.apiKey) gemini = { apiKey: cfg.apiKey, provider: createGeminiProvider({ apiKey: cfg.apiKey }) };
  return gemini.provider;
};

let defaultClient = null;
let testSleep = null;
export const getAiClient = () => {
  if (!defaultClient) defaultClient = createAiClient({ provider: currentProvider, sleep: (ms) => (testSleep || realSleep)(ms) });
  return defaultClient;
};

/** Tests only: swap the provider (and skip the backoff waits). Pass null to reset. */
export const setAiProviderForTests = (provider, { sleep = async () => {} } = {}) => {
  override = provider;
  testSleep = provider ? sleep : null;
};
