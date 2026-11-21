// AI-0: the ONLY way feature code should call the model. Each function:
//   1. checks the feature is on (server + school + feature switch)  -> AiUnavailableError 403
//   2. checks this month's spend is below the cap                   -> AiQuotaError 429 (logged BLOCKED)
//   3. scrubs phone numbers / emails out of every message (redactText)
//   4. calls the client (timeout, retries, JSON check)
//   5. writes one Ai_usage_log row (OK or ERROR + errorClass, with the cost)
//   6. on failure throws a friendly AppError (code AI_FAILED, errorClass) a
//      route can pass straight to next(); the page should keep working by hand.
//
// Common arguments:
//   feature        "ASK" | "PAPERS" | ... (constants.js)
//   user           req.user (who is logged; "OFFICE:<username>" / "STAFF:<id>")
//   prompt         renderPrompt(...) result: { system, user, promptVersion }
//                  (or pass system / messages / promptVersion yourself)
//   model          optional; default AI_MODEL_DEFAULT
//   temperature, maxOutputTokens, timeoutMs, signal  optional
//
//   runJson({ ...common, schema, validate })  -> { data, usage, model, promptVersion, costGhs }
//   runText({ ...common })                    -> { text, usage, model, promptVersion, costGhs }
//   runChat({ ...common, messages, tools })   -> { text, toolCalls, usage, ... } one model turn
//   streamText({ ...common })                 -> async iterable of client.stream chunks
//                                                (usage logged when the stream ends)
//   runToolLoop({ ...common, tools: [{ name, description, parameters, handler }] })
//                                             -> { text, toolsUsed, turns, usage, costGhs }
import { aiConfig } from "./config.js";
import { addUsage, getAiClient, ZERO_USAGE } from "./client.js";
import { AiProviderError, toUserError } from "./errors.js";
import { assertAiFeatureOn } from "./gate.js";
import { redactForAi, redactText } from "./redact.js";
import { assertWithinBudget, recordUsage } from "./usage.js";

const scrubMessages = (messages = []) =>
  messages.map((m) => ({
    ...m,
    content: redactText(m.content),
    ...(m.toolResults ? { toolResults: m.toolResults.map((r) => ({ ...r, result: redactForAi(r.result) })) } : {}),
  }));

const buildRequest = ({ prompt, system, messages, model, temperature, maxOutputTokens, timeoutMs, signal, tools }) => {
  const msgs = messages || (prompt?.user ? [{ role: "user", content: prompt.user }] : []);
  return {
    model: model || aiConfig().defaultModel,
    system: redactText(system ?? prompt?.system),
    messages: scrubMessages(msgs),
    ...(tools ? { tools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal ? { signal } : {}),
  };
};

const preflight = async ({ feature, user, model }) => {
  await assertAiFeatureOn(feature);
  await assertWithinBudget({ feature, user, model: model || aiConfig().defaultModel });
};

// Run one metered call: fn(req) -> { usage, ...result }.
const metered = async (args, fn) => {
  const { feature, user, prompt } = args;
  const promptVersion = args.promptVersion || prompt?.promptVersion || null;
  await preflight(args);
  const req = buildRequest(args);
  const started = Date.now();
  try {
    const result = await fn(req);
    const { costGhs } = await recordUsage({ feature, user, model: req.model, promptVersion, usage: result.usage, status: "OK", latencyMs: Date.now() - started });
    return { ...result, model: result.usage?.model || req.model, promptVersion, costGhs };
  } catch (error) {
    const errorClass = error instanceof AiProviderError ? error.errorClass : "UNKNOWN";
    await recordUsage({
      feature,
      user,
      model: req.model,
      promptVersion,
      usage: error?.usage,
      status: "ERROR",
      errorClass,
      errorMessage: error?.message,
      latencyMs: Date.now() - started,
    });
    if (!(error instanceof AiProviderError)) console.error(`AI ${feature} failed:`, error);
    throw toUserError(error);
  }
};

export const runJson = (args) =>
  metered(args, (req) => getAiClient().generateJson({ ...req, schema: args.schema, validate: args.validate }));

export const runText = (args) => metered(args, (req) => getAiClient().generateText(req));

export const runChat = (args) => metered(args, (req) => getAiClient().chat(req));

/**
 * Streaming text (e.g. AI-1 over SSE). The preflight runs before the first
 * chunk; usage is logged when the stream finishes or fails. A consumer that
 * stops early (client disconnected) should call `return()` on the iterator;
 * the row is still written with the tokens seen so far.
 */
export async function* streamText(args) {
  const { feature, user, prompt } = args;
  const promptVersion = args.promptVersion || prompt?.promptVersion || null;
  await preflight(args);
  const req = buildRequest(args);
  const started = Date.now();
  let usage = null;
  let failed = null;
  try {
    for await (const chunk of getAiClient().stream(req)) {
      if (chunk.type === "usage") usage = chunk.usage;
      yield chunk;
    }
  } catch (error) {
    failed = error;
    throw toUserError(error);
  } finally {
    await recordUsage({
      feature,
      user,
      model: req.model,
      promptVersion,
      usage,
      status: failed ? "ERROR" : "OK",
      errorClass: failed ? (failed instanceof AiProviderError ? failed.errorClass : "UNKNOWN") : null,
      errorMessage: failed?.message,
      latencyMs: Date.now() - started,
    });
  }
}

const MAX_TOOL_RESULT_CHARS = 12_000;

/**
 * A small agent loop for AI-1 (or anything with tools). Each model turn is one
 * metered call (switch + budget checked, usage logged), so a loop that hits
 * the cap stops with AiQuotaError between turns.
 *
 * tools: [{ name, description, parameters (JSON Schema), handler: async (args, ctx) => result }]
 *   handler results are passed through redactForAi before the model sees them
 *   and cut to MAX_TOOL_RESULT_CHARS (the model is told when). A handler that
 *   throws becomes { error: message } for the model, not a failed request.
 *   ctx = { user, feature } so a handler can scope by caller (e.g. AI-1 limits
 *   the Accountant to finance tools: pass only those tools for that role).
 * maxIterations defaults to AI_MAX_TOOL_ITERATIONS (5).
 */
export const runToolLoop = async ({ tools = [], maxIterations, messages, prompt, ...args }) => {
  const limit = maxIterations || aiConfig().maxToolIterations;
  const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...(messages || (prompt?.user ? [{ role: "user", content: prompt.user }] : []))];
  const toolsUsed = [];
  let usage = { ...ZERO_USAGE };
  let costGhs = 0;

  for (let turn = 1; turn <= limit; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runChat({ ...args, prompt, system: args.system ?? prompt?.system, messages: convo, tools: declarations });
    usage = addUsage(usage, res.usage);
    costGhs = Math.round((costGhs + (res.costGhs || 0)) * 10000) / 10000;
    if (!res.toolCalls?.length) {
      return { text: res.text, toolsUsed, turns: turn, usage, costGhs, promptVersion: res.promptVersion, model: res.model };
    }
    convo.push({ role: "assistant", content: res.text || "", toolCalls: res.toolCalls });
    const results = [];
    for (const call of res.toolCalls) {
      const tool = byName.get(call.name);
      toolsUsed.push(call.name);
      let result;
      if (!tool) {
        result = { error: `There is no tool called ${call.name}.` };
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await tool.handler(call.args || {}, { user: args.user, feature: args.feature });
        } catch (error) {
          result = { error: error?.message || "The tool failed." };
        }
      }
      let safe = redactForAi(result);
      let truncated = false;
      const text = JSON.stringify(safe ?? null);
      if (text && text.length > MAX_TOOL_RESULT_CHARS) {
        safe = text.slice(0, MAX_TOOL_RESULT_CHARS);
        truncated = true;
      }
      results.push({ callId: call.id, name: call.name, result: safe, truncated });
    }
    convo.push({ role: "tool", content: "", toolResults: results });
  }
  // Out of turns: say so rather than return half an answer as if complete.
  throw toUserError(new AiProviderError("MALFORMED_OUTPUT", `No answer after ${limit} tool rounds`));
};
