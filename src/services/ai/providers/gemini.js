// AI-0: the one file that knows Gemini exists (ported from SchoolPro's
// gemini.provider.ts). Everything above it speaks our own shapes:
//
//   request  { model, system, messages: [{ role: user|assistant|tool|system,
//              content, toolCalls?, toolResults?, files? }], tools?: [{ name,
//              description, parameters (JSON Schema) }], json?: { schema },
//              temperature?, maxOutputTokens? }
//   response { text, toolCalls: [{ id, name, args, providerSignature? }],
//              usage: { inputTokens, cachedTokens, outputTokens, model },
//              finishReason, blockReason }
//
// It throws the SDK's raw errors; client.js classifies them. The SDK is loaded
// on first use, so the API boots (and tests run) without it being touched.

let sdkPromise = null;
const loadSdk = () => {
  if (!sdkPromise) sdkPromise = import("@google/genai");
  return sdkPromise;
};

// System-role messages are folded into the system instruction: Gemini has no
// system role in `contents`.
export const systemInstructionFor = (system, messages = []) => {
  const pieces = [system, ...messages.filter((m) => m.role === "system").map((m) => m.content)]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return pieces.length ? pieces.join("\n\n") : undefined;
};

export const toContents = (messages = []) => {
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const parts = (message.toolResults || []).map((r) => ({
        functionResponse: {
          id: r.callId,
          name: r.name,
          response: r.truncated ? { output: r.result, truncated: true } : { output: r.result },
        },
      }));
      if (message.content?.trim()) parts.push({ text: message.content });
      // Tool results go back on a user turn: that is where Gemini expects them.
      if (parts.length) contents.push({ role: "user", parts });
      continue;
    }
    const parts = [];
    if (message.content?.trim()) parts.push({ text: message.content });
    if (message.role === "user") {
      for (const file of message.files || []) parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
    }
    for (const call of message.toolCalls || []) {
      parts.push({
        functionCall: { id: call.id, name: call.name, args: call.args },
        // Gemini 3 refuses the next turn (400) when a functionCall comes back
        // without the thoughtSignature it issued. Replay it verbatim.
        ...(call.providerSignature ? { thoughtSignature: call.providerSignature } : {}),
      });
    }
    if (!parts.length) continue;
    contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return contents;
};

export const toGeminiTools = (tools) =>
  tools?.length
    ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
    : undefined;

const partsOf = (response) => response?.candidates?.[0]?.content?.parts || [];

// Thought parts are billed but are not the answer, and never shown.
const textOf = (response) =>
  partsOf(response)
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

const toToolCall = (call, index, signature) => ({
  // The Developer API often omits the id; mint one so results match calls.
  id: call.id || `call_${index}_${call.name || "unnamed"}`,
  name: call.name || "",
  args: call.args || {},
  ...(signature ? { providerSignature: signature } : {}),
});

const toolCallsOf = (response) => {
  const calls = [];
  for (const part of partsOf(response)) {
    if (part.functionCall) calls.push(toToolCall(part.functionCall, calls.length, part.thoughtSignature));
  }
  return calls;
};

// promptTokenCount already includes cached tokens; tool-use prompt tokens are
// billed input; thoughts are billed output.
export const usageOf = (response, requestedModel) => {
  const meta = response?.usageMetadata || {};
  const cached = meta.cachedContentTokenCount || 0;
  return {
    inputTokens: Math.max(0, (meta.promptTokenCount || 0) + (meta.toolUsePromptTokenCount || 0) - cached),
    cachedTokens: cached,
    outputTokens: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
    model: response?.modelVersion || requestedModel,
  };
};

export const normalise = (response, requestedModel) => ({
  text: textOf(response),
  toolCalls: toolCallsOf(response),
  usage: usageOf(response, requestedModel),
  finishReason: response?.candidates?.[0]?.finishReason,
  blockReason: response?.promptFeedback?.blockReason,
});

const configFor = (req, signal) => {
  const system = systemInstructionFor(req.system, req.messages);
  const tools = toGeminiTools(req.tools);
  return {
    abortSignal: signal,
    ...(system ? { systemInstruction: system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
    ...(tools ? { tools } : {}),
    // `responseJsonSchema` takes JSON Schema as written (`responseSchema` wants
    // the OpenAPI subset), so our schemas need no translation.
    ...(req.json ? { responseMimeType: "application/json", responseJsonSchema: req.json.schema } : {}),
  };
};

export const createGeminiProvider = ({ apiKey }) => {
  let client = null;
  const getClient = async () => {
    if (!client) {
      const { GoogleGenAI } = await loadSdk();
      client = new GoogleGenAI({ apiKey });
    }
    return client;
  };

  return {
    id: "gemini",
    async generate(req, signal) {
      const c = await getClient();
      const response = await c.models.generateContent({
        model: req.model,
        contents: toContents(req.messages),
        config: configFor(req, signal),
      });
      return normalise(response, req.model);
    },
    // Async iterable of normalised chunks; usage arrives as running totals,
    // so the caller keeps the last one.
    async stream(req, signal) {
      const c = await getClient();
      const chunks = await c.models.generateContentStream({
        model: req.model,
        contents: toContents(req.messages),
        config: configFor(req, signal),
      });
      return (async function* gen() {
        for await (const chunk of chunks) yield normalise(chunk, req.model);
      })();
    },
  };
};
