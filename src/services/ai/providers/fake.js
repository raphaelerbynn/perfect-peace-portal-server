// AI-0: a provider that never touches the network. Used by the tests (give it
// a script) and by AI_FAKE_PROVIDER=1 in development (canned answers).
//
//   createFakeProvider([
//     { text: "hello" },                                 // a plain answer
//     { json: { title: "x" } },                          // generateJson answer
//     { toolCalls: [{ name: "count_pupils", args: {} }] },
//     { error: Object.assign(new Error("429"), { status: 429 }) },
//     (req) => ({ text: `echo ${req.messages.at(-1).content}` }),
//   ])
//
// Each call takes the next step (the last one repeats). `calls` records every
// request the provider saw, so a test can assert what was sent.

const DEFAULT_USAGE = { inputTokens: 100, cachedTokens: 0, outputTokens: 50 };

const toResponse = (step, req) => {
  const s = typeof step === "function" ? step(req) : step;
  if (s?.error) throw s.error;
  const text = s?.json !== undefined ? JSON.stringify(s.json) : s?.text ?? "";
  return {
    text,
    toolCalls: (s?.toolCalls || []).map((c, i) => ({ id: c.id || `call_${i}_${c.name}`, args: {}, ...c })),
    usage: { ...DEFAULT_USAGE, ...(s?.usage || {}), model: req.model },
    finishReason: s?.finishReason || "STOP",
    blockReason: s?.blockReason,
  };
};

export const createFakeProvider = (script = []) => {
  const steps = Array.isArray(script) ? script : [script];
  let i = 0;
  const next = () => steps[Math.min(i++, Math.max(steps.length - 1, 0))];
  const provider = {
    id: "fake",
    calls: [],
    async generate(req) {
      provider.calls.push(req);
      if (!steps.length) return toResponse(cannedAnswer(req), req);
      return toResponse(next(), req);
    },
    async stream(req) {
      const full = await provider.generate(req);
      const words = full.text.split(/(\s+)/).filter(Boolean);
      return (async function* gen() {
        for (const w of words) yield { text: w, toolCalls: [], usage: undefined };
        yield { text: "", toolCalls: full.toolCalls, usage: full.usage, finishReason: full.finishReason };
      })();
    },
  };
  return provider;
};

// AI_FAKE_PROVIDER=1 without a script: a minimal answer that fits any schema
// we can guess, so the screens can be clicked through without a key.
const sample = (schema) => {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sample(v)]));
    case "array":
      return schema.items ? Array.from({ length: Math.max(1, schema.minItems || 1) }, () => sample(schema.items)) : [];
    case "string":
      return "(sample text from the fake AI provider)";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    default:
      return null;
  }
};

const cannedAnswer = (req) =>
  req.json ? { json: sample(req.json.schema) } : { text: "This is a sample answer from the fake AI provider (AI_FAKE_PROVIDER=1). No real AI was used." };
