// AI-1: Ask the school over Server-Sent Events. Everything that can refuse
// (bad question, hourly limit, someone else's conversation, the budget) runs
// in prepareAsk BEFORE the stream opens, so those are ordinary JSON errors.
// Once open, each event is written as `event: <type>\ndata: <json>\n\n`
// (text / tool / conversation / error / done). If the asker closes the panel,
// presses Stop or loses the connection, the response closes and the abort
// signal stops the model and any tools still to run.
import { deleteConversation, getConversation, listConversations, prepareAsk, runAsk } from "../services/ai/ask/chat.js";

export const writeEvent = (res, event) => {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

export const postAsk = async (req, res, next) => {
  let prepared;
  try {
    prepared = await prepareAsk(req.body, req.user);
  } catch (error) {
    return next(error);
  }

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't hold the stream back
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  try {
    for await (const event of runAsk(prepared, req.user, { signal: controller.signal })) writeEvent(res, event);
  } catch (error) {
    console.error("AI-1 ask failed:", error);
    writeEvent(res, { type: "error", code: "AI_FAILED", message: "Something went wrong. Please try again." });
    writeEvent(res, { type: "done", status: "ERROR" });
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
  return undefined;
};

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    next(error);
  }
};

export const getMyConversations = send((req) => listConversations(req.user, req.query));
export const getMyConversation = send((req) => getConversation(req.params.id, req.user));
export const deleteMyConversation = send((req) => deleteConversation(req.params.id, req.user));
