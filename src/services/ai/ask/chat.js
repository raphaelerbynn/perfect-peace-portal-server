// AI-1: "Ask the school". Ported from SchoolPro chat/ai-chat.service.ts.
//
//   prepareAsk({ question, conversationId }, user)   everything that can refuse
//       BEFORE the SSE stream opens, so the refusal is a plain HTTP error:
//       400 bad question, 429 AI_ASK_LIMIT (the per-user hourly limit),
//       404 someone else's conversation, the fast path, then the budget
//       (429 AI_QUOTA + a BLOCKED usage row). The fast path runs before the
//       budget: over the cap, "how many pupils" still gets its free answer.
//   runAsk(prepared, user, { signal })   async generator of events for SSE:
//       { type: "conversation", conversationId, title }
//       { type: "tool", name, label, status: "started" | "finished" | "failed" }
//       { type: "text", text }                            (answer, streamed)
//       { type: "error", code, message, ... }             (then done)
//       { type: "done", conversationId, messageId, toolsUsed, fastPath, status, costGhs }
//
// The loop: each turn streams one model call (run.js streamText, so the
// switches and the cap are re-checked and every turn is a usage row). Text is
// passed on as it arrives; tool calls are run (role-checked again at call
// time), their results redacted and cut, and the next turn starts. At most
// AI_MAX_TOOL_ITERATIONS (5) model turns, then a "narrow it down" note.
// A stop (Stop button / page closed): `signal` aborts the turn in progress,
// no more tools run, and what was written so far is saved as STOPPED.
import { Op } from "sequelize";
import { AiConversation, AiMessage } from "../../../models/index.js";
import { AppError } from "../../../utils/errorHandling.js";
import { getSchoolSettings } from "../../school.js";
import { aiConfig } from "../config.js";
import { AiAppError, toUserError } from "../errors.js";
import { renderPrompt } from "../prompts/registry.js";
import { ASK_PROMPT } from "../prompts/ask.js";
import { redactForAi } from "../redact.js";
import { streamText } from "../run.js";
import { actorOf, assertWithinBudget, costOf } from "../usage.js";
import { tryFastPath } from "./fastPath.js";
import { declarationsFor, invokeTool, toolsFor } from "./tools.js";

export const QUESTION_MAX = 1000;
export const MAX_TOOL_RESULT_CHARS = 12_000; // as run.js
const HISTORY_MESSAGES = 10;
const TITLE_MAX = 80;
const LIST_MAX = 50;

/** Questions per user per rolling hour (AI_ASK_PER_HOUR, default 20). */
export const askLimitPerHour = () => {
  const n = Number(process.env.AI_ASK_PER_HOUR);
  return Number.isInteger(n) && n > 0 ? n : 20;
};

const TOOL_LABELS = [
  ["current_term", "Checking the term"],
  ["students_", "Counting pupils"],
  ["fees_", "Checking fees"],
  ["income_expense", "Checking income and expenses"],
  ["attendance_", "Checking attendance"],
  ["results_", "Checking results"],
  ["staff_attendance", "Checking staff attendance"],
  ["staff_", "Checking staff"],
];
export const toolLabel = (name) => TOOL_LABELS.find(([p]) => String(name).startsWith(p))?.[1] || "Looking it up";

const STOP_NOTE =
  "I stopped after checking several things without settling it. Try asking about one class, one term or one subject at a time.";
const EMPTY_NOTE = "I couldn't find an answer to that in the school's records.";

class AskStopped extends Error {}

const titleOf = (question) => {
  const t = String(question).replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
};

const ownerOf = (user) => {
  const ref = actorOf(user);
  if (!ref || !user?.category) throw new AppError("Only office logins can use Ask the school.", 403);
  return ref;
};

const idOf = (value, what = "conversation") => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`That ${what} was not found.`, 404);
  return n;
};

// ---------------------------------------------------------------- conversations (own only)

const conversationView = (c) => ({
  conversationId: Number(c.conversationId),
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const messageView = (m) => ({
  messageId: Number(m.messageId),
  role: m.role,
  content: m.content,
  toolsUsed: Array.isArray(m.toolsUsed) ? m.toolsUsed : [],
  fastPath: Boolean(m.fastPath),
  status: m.status,
  createdAt: m.createdAt,
});

/** GET /ai/conversations: the caller's own, newest first. */
export const listConversations = async (user, { limit } = {}) => {
  const userRef = ownerOf(user);
  const n = Math.min(LIST_MAX, Math.max(1, Number.parseInt(limit, 10) || 30));
  const rows = await AiConversation.findAll({ where: { userRef }, order: [["updatedAt", "DESC"], ["conversationId", "DESC"]], limit: n, raw: true });
  return { conversations: rows.map(conversationView) };
};

const ownConversation = async (id, userRef) => {
  const conversationId = idOf(id);
  const row = await AiConversation.findOne({ where: { conversationId, userRef }, raw: true });
  // Someone else's conversation looks exactly like one that doesn't exist.
  if (!row) throw new AppError("That conversation was not found.", 404);
  return row;
};

/** GET /ai/conversations/:id: one of the caller's own, with its messages. */
export const getConversation = async (id, user) => {
  const conv = await ownConversation(id, ownerOf(user));
  const messages = await AiMessage.findAll({ where: { conversationId: conv.conversationId }, order: [["messageId", "ASC"]], raw: true });
  return { ...conversationView(conv), messages: messages.map(messageView) };
};

/** DELETE /ai/conversations/:id: the caller's own only (its messages go with it). */
export const deleteConversation = async (id, user) => {
  const conv = await ownConversation(id, ownerOf(user));
  await AiMessage.destroy({ where: { conversationId: conv.conversationId } });
  await AiConversation.destroy({ where: { conversationId: conv.conversationId, userRef: conv.userRef } });
  return { deleted: true, conversationId: Number(conv.conversationId) };
};

// ---------------------------------------------------------------- the per-user limit

export const assertAskLimit = async (userRef, now = new Date()) => {
  const limit = askLimitPerHour();
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const used = await AiMessage.count({ where: { userRef, role: "USER", createdAt: { [Op.gte]: since } } });
  if (used >= limit) {
    throw new AiAppError(
      `You've asked ${limit} questions in the last hour, which is the limit. Please wait a little and ask again; the pages of the system still have every figure.`,
      429,
      "AI_ASK_LIMIT",
      { limit, used }
    );
  }
  return { limit, used };
};

// ---------------------------------------------------------------- prepare (may refuse)

export const prepareAsk = async (body, user) => {
  const userRef = ownerOf(user);
  const question = String(body?.question ?? "").replace(/\s+$/g, "").trim();
  if (!question) throw new AppError("Type a question first.", 400);
  if (question.length > QUESTION_MAX) throw new AppError(`Please keep the question under ${QUESTION_MAX} characters.`, 400);

  await assertAskLimit(userRef);

  const has = body?.conversationId !== undefined && body?.conversationId !== null && body?.conversationId !== "";
  const conversation = has ? await ownConversation(body.conversationId, userRef) : null;

  const fast = await tryFastPath(question, { user });
  if (!fast) await assertWithinBudget({ feature: "ASK", user }); // 429 AI_QUOTA, logged BLOCKED

  let history = [];
  if (conversation && !fast) {
    const rows = await AiMessage.findAll({
      where: { conversationId: conversation.conversationId, status: "OK" },
      order: [["messageId", "DESC"]],
      limit: HISTORY_MESSAGES,
      raw: true,
    });
    history = rows
      .reverse()
      .filter((m) => m.content)
      .map((m) => ({ role: m.role === "ASSISTANT" ? "assistant" : "user", content: m.content }));
  }
  return { question, userRef, conversation, fast, history };
};

// ---------------------------------------------------------------- run (streams events)

const saveMessage = (row) =>
  AiMessage.create({ toolsUsed: [], fastPath: false, status: "OK", costGhs: 0, promptVersion: null, createdAt: new Date(), ...row });

const startConversation = async ({ conversation, question, userRef }) => {
  const now = new Date();
  if (conversation) {
    await AiConversation.update({ updatedAt: now }, { where: { conversationId: conversation.conversationId, userRef } });
    return conversation;
  }
  const created = await AiConversation.create({ userRef, title: titleOf(question), createdAt: now, updatedAt: now });
  return created.get ? created.get({ plain: true }) : created;
};

/** Settles when `signal` aborts (never otherwise). */
const whenAborted = (signal) => {
  const p = new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new AskStopped());
    else signal.addEventListener("abort", () => reject(new AskStopped()), { once: true });
  });
  p.catch(() => {});
  return p;
};

/** The model's chunks, stopping at once when `signal` aborts (the stream is closed behind us). */
async function* untilAborted(iterable, signal) {
  const it = iterable[Symbol.asyncIterator]();
  const stop = whenAborted(signal);
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const step = await Promise.race([it.next(), stop]);
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Closing the generator logs the turn's usage (run.js) and ends the provider stream.
    Promise.resolve()
      .then(() => it.return?.())
      .catch(() => {});
  }
}

const safeResult = (result) => {
  let safe = redactForAi(result);
  const text = JSON.stringify(safe ?? null);
  let truncated = false;
  if (text && text.length > MAX_TOOL_RESULT_CHARS) {
    safe = `${text.slice(0, MAX_TOOL_RESULT_CHARS)} [PARTIAL: cut to ${MAX_TOOL_RESULT_CHARS} characters]`;
    truncated = true;
  }
  return { safe, truncated };
};

const todayText = () => new Date().toISOString().slice(0, 10);

export async function* runAsk(prepared, user, { signal, maxIterations } = {}) {
  const { question, userRef, fast, history } = prepared;
  const conversation = await startConversation(prepared);
  const conversationId = Number(conversation.conversationId);
  await saveMessage({ conversationId, userRef, role: "USER", content: question });
  yield { type: "conversation", conversationId, title: conversation.title };

  // Free answer: no model, no usage row, nothing against the cap.
  if (fast) {
    for (const name of fast.toolsUsed) yield { type: "tool", name, label: toolLabel(name), status: "finished" };
    yield { type: "text", text: fast.text };
    const msg = await saveMessage({ conversationId, userRef, role: "ASSISTANT", content: fast.text, toolsUsed: fast.toolsUsed, fastPath: true });
    yield { type: "done", conversationId, messageId: Number(msg.messageId ?? msg.get?.("messageId")), toolsUsed: fast.toolsUsed, fastPath: true, status: "OK", costGhs: 0 };
    return;
  }

  const school = await getSchoolSettings().catch(() => null);
  const declarations = declarationsFor(user);
  const prompt = renderPrompt(ASK_PROMPT, {
    schoolName: school?.name || "the school",
    today: todayText(),
    role: user.category,
    toolNames: declarations.map((d) => d.name),
    question,
  });
  const convo = [...history, { role: "user", content: prompt.user }];
  const limit = maxIterations || aiConfig().maxToolIterations;
  const toolsUsed = [];
  let answer = "";
  let costGhs = 0;
  let status = "OK";
  let failure = null;

  try {
    let finished = false;
    for (let turn = 1; turn <= limit && !finished; turn += 1) {
      if (signal?.aborted) throw new AskStopped();
      const calls = [];
      let turnText = "";
      const stream = streamText({ feature: "ASK", user, prompt, system: prompt.system, messages: convo, tools: declarations, signal });
      // eslint-disable-next-line no-await-in-loop
      for await (const chunk of untilAborted(stream, signal)) {
        if (chunk.type === "text" && chunk.text) {
          turnText += chunk.text;
          answer += chunk.text;
          yield { type: "text", text: chunk.text };
        } else if (chunk.type === "tool_call") {
          calls.push(chunk.call);
        } else if (chunk.type === "usage") {
          costGhs = Math.round((costGhs + costOf(chunk.usage).costGhs) * 10000) / 10000;
        }
      }
      if (signal?.aborted) throw new AskStopped();
      if (!calls.length) {
        finished = true;
        break;
      }

      convo.push({ role: "assistant", content: turnText, toolCalls: calls });
      const results = [];
      for (const call of calls) {
        if (signal?.aborted) throw new AskStopped();
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        yield { type: "tool", name: call.name, label: toolLabel(call.name), status: "started" };
        let result;
        let ok = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await invokeTool(call.name, call.args || {}, { user });
        } catch (error) {
          ok = false;
          result = { error: error?.message || "That couldn't be looked up." };
        }
        if (signal?.aborted) throw new AskStopped();
        const { safe, truncated } = safeResult(result);
        results.push({ callId: call.id, name: call.name, result: safe, truncated });
        yield { type: "tool", name: call.name, label: toolLabel(call.name), status: ok ? "finished" : "failed" };
      }
      convo.push({ role: "tool", content: "", toolResults: results });
      if (turn === limit) {
        const note = `${answer ? "\n\n" : ""}${STOP_NOTE}`;
        answer += note;
        yield { type: "text", text: note };
      }
    }
    if (finished && !answer.trim()) {
      answer = EMPTY_NOTE;
      yield { type: "text", text: EMPTY_NOTE };
    }
  } catch (error) {
    if (error instanceof AskStopped || signal?.aborted) {
      status = "STOPPED";
    } else {
      status = "ERROR";
      failure = toUserError(error);
    }
  }

  const content = answer || (status === "STOPPED" ? "(Stopped before an answer.)" : failure?.message || EMPTY_NOTE);
  let messageId = null;
  try {
    const msg = await saveMessage({ conversationId, userRef, role: "ASSISTANT", content, toolsUsed, status, costGhs, promptVersion: prompt.promptVersion });
    messageId = Number(msg.messageId ?? msg.get?.("messageId"));
  } catch (error) {
    console.error("AI-1 answer not saved:", error?.message || error);
  }
  if (failure) {
    yield { type: "error", code: failure.code || "AI_FAILED", message: failure.message, ...(failure.details || {}) };
  }
  yield { type: "done", conversationId, messageId, toolsUsed, fastPath: false, status, costGhs };
}

export { toolsFor };
