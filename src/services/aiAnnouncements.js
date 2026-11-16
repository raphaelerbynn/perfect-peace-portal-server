// AI-8: AI-drafted announcements (news posts and SMS), built on AI-0.
//
//   POST /ai/announcements/draft  { mode: "news" | "sms", purpose, audience, keyFacts[], length? }
//     news: length = "short" | "medium" | "long" (default medium); optional
//           post: { audience: ALL | CLASSES | STAFF, audienceClassIds } for the post it becomes
//     sms:  length = 1 | 2 SMS parts (default 1): at most 160 / 306 plain
//           characters, or 70 / 134 when the text needs Unicode (utils/sms.js)
//   -> { suggestion, sms? }  an Ai_suggestion (PENDING) the office reviews.
//
// Rules (from SchoolPro's announcement.service.ts):
//   - every date, time, weekday and year in the draft must be in the key facts
//     (utils/dateGuard.js). A draft that breaks it is retried once with the
//     reason, then refused with a plain message;
//   - an SMS draft is put into plain GSM characters and must fit the parts
//     asked for; retried once, then refused;
//   - phone numbers and emails never reach the model (run.js scrubs every
//     message; we scrub the brief first too, so the guard and the stored
//     draft see what the model saw).
//
// Accepting (POST /ai/suggestions/:id/accept, AI-0):
//   news -> a B15 post with status DRAFT, inside the accept transaction. Never
//           published here, so no B16 notification; the office reviews it and
//           publishes with the usual button.
//   sms  -> nothing is sent: the text comes back (`applied.text`) for the SMS box.
import { AI_FEATURES } from "./ai/constants.js";
import { AiAppError } from "./ai/errors.js";
import { renderPrompt } from "./ai/prompts/index.js";
import { redactText } from "./ai/redact.js";
import { runJson } from "./ai/run.js";
import { getAiSettings } from "./ai/settings.js";
import { createSuggestion, registerAcceptHandler } from "./ai/suggestions.js";
import { actorOf } from "./ai/usage.js";
import { ANNOUNCEMENT_LENGTHS, ANNOUNCEMENT_PROMPT } from "./ai/prompts/announcement.js";
import { createDraftPostInTransaction } from "./posts.js";
import { getSchoolSettings } from "./school.js";
import { AppError } from "../utils/errorHandling.js";
import { ungroundedSpecifics } from "../utils/dateGuard.js";
import { normaliseSms, smsInfo, smsLimit, SMS_MAX_PARTS } from "../utils/sms.js";

const FEATURE = AI_FEATURES.ANNOUNCEMENTS;
export const DRAFT_LIMITS = Object.freeze({ purpose: 500, audience: 120, fact: 200, facts: 12 });
// B15's post limits (posts.js LIMITS), repeated so this module loads even where posts.js is mocked.
const POST_LIMITS = Object.freeze({ title: 150, body: 10000 });
const SMS_TEXT_MAX = 1000; // what an edited SMS draft may hold (the A7 box has no cap)

const bad = (message) => new AppError(message, 400);
const clean = (v) => (v === undefined || v === null ? "" : String(v).replace(/\s+/g, " ").trim());

/** The request, checked and scrubbed of contact data. */
export const parseDraftRequest = (body = {}) => {
  const mode = clean(body.mode).toLowerCase() || "news";
  if (!["news", "sms"].includes(mode)) throw bad('Choose "news" or "sms".');

  const purpose = clean(body.purpose);
  if (!purpose) throw bad("Say what the notice is for.");
  if (purpose.length > DRAFT_LIMITS.purpose) throw bad(`What it is for can be at most ${DRAFT_LIMITS.purpose} characters.`);
  const audience = clean(body.audience);
  if (audience.length > DRAFT_LIMITS.audience) throw bad(`Who it is for can be at most ${DRAFT_LIMITS.audience} characters.`);

  const rawFacts = Array.isArray(body.keyFacts) ? body.keyFacts : typeof body.keyFacts === "string" ? body.keyFacts.split("\n") : [];
  if (body.keyFacts !== undefined && body.keyFacts !== null && !Array.isArray(body.keyFacts) && typeof body.keyFacts !== "string") {
    throw bad("Key facts must be a list.");
  }
  const keyFacts = rawFacts.map(clean).filter(Boolean);
  if (keyFacts.length > DRAFT_LIMITS.facts) throw bad(`Give at most ${DRAFT_LIMITS.facts} key facts.`);
  if (keyFacts.some((f) => f.length > DRAFT_LIMITS.fact)) throw bad(`Each key fact can be at most ${DRAFT_LIMITS.fact} characters.`);

  let length;
  if (mode === "sms") {
    length = body.length === undefined || body.length === null || body.length === "" ? 1 : Number(body.length);
    if (!Number.isInteger(length) || length < 1 || length > SMS_MAX_PARTS) throw bad(`An SMS draft can be 1 or ${SMS_MAX_PARTS} parts.`);
  } else {
    length = clean(body.length).toLowerCase() || "medium";
    if (!ANNOUNCEMENT_LENGTHS[length]) throw bad('Choose a length: "short", "medium" or "long".');
  }

  // The post it becomes (news): checked again by B15 when it is accepted.
  let post = null;
  if (mode === "news" && body.post && typeof body.post === "object") {
    const a = clean(body.post.audience).toUpperCase() || "ALL";
    if (!["ALL", "CLASSES", "STAFF"].includes(a)) throw bad("Choose who can see the post.");
    const ids = a === "CLASSES" && Array.isArray(body.post.audienceClassIds) ? body.post.audienceClassIds.map(Number) : null;
    if (a === "CLASSES" && (!ids || !ids.length || ids.some((x) => !Number.isInteger(x) || x <= 0))) throw bad("Choose the classes for the post.");
    post = { audience: a, audienceClassIds: ids };
  }

  // Scrub phone numbers / emails before anything else sees the brief.
  return {
    mode,
    purpose: redactText(purpose),
    audience: redactText(audience),
    keyFacts: keyFacts.map(redactText),
    length,
    post,
  };
};

const SCHEMAS = {
  news: {
    type: "object",
    required: ["title", "body"],
    properties: {
      title: { type: "string", maxLength: POST_LIMITS.title, description: "A short headline naming the thing. No school name, no date prefix." },
      body: { type: "string", maxLength: 3000, description: "The notice, in short paragraphs separated by a blank line." },
    },
  },
  sms: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", maxLength: SMS_TEXT_MAX, description: "The whole SMS, plain characters only." } },
  },
};

const DATE_REFUSAL = (flagged) =>
  `The AI kept writing ${flagged.length === 1 ? "a date or time" : "dates or times"} that ${flagged.length === 1 ? "isn't" : "aren't"} in your key facts ` +
  `(${flagged.slice(0, 3).map((f) => `"${f}"`).join(", ")}), so the draft was not used. Put every date and time in the key facts and try again, or write it by hand.`;
const SMS_REFUSAL = (chars, max, parts) =>
  `The AI couldn't fit the message into ${parts} SMS part${parts === 1 ? "" : "s"} (it wrote ${chars} characters; the limit is ${max}). ` +
  `Try ${parts === 1 ? "2 parts, " : ""}fewer key facts, or write it by hand.`;

/**
 * The check run on each model answer (runJson retries once with the problem).
 * Returns { problem, guard, flagged? } or { value } with the cleaned draft.
 */
export const checkDraft = (data, req, { now } = {}) => {
  if (req.mode === "sms") {
    const text = normaliseSms(data?.text);
    if (!text) return { problem: "the SMS was empty", guard: "EMPTY" };
    const info = smsInfo(text);
    const max = smsLimit(req.length, info.encoding);
    if (info.chars > max) {
      return {
        problem: `the SMS is ${info.chars} characters but must be at most ${max} (${req.length} part${req.length === 1 ? "" : "s"}); write it shorter`,
        guard: "SMS_LENGTH",
        chars: info.chars,
        max,
      };
    }
    const flagged = ungroundedSpecifics(text, req.keyFacts, { now });
    if (flagged.length) return { problem: datesProblem(flagged), guard: "DATES", flagged };
    return { value: { text }, info };
  }
  const title = clean(data?.title);
  const body = String(data?.body ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!title || !body) return { problem: "the title or the body was empty", guard: "EMPTY" };
  const flagged = ungroundedSpecifics(`${title}\n${body}`, req.keyFacts, { now });
  if (flagged.length) return { problem: datesProblem(flagged), guard: "DATES", flagged };
  return { value: { title, body } };
};

const datesProblem = (flagged) =>
  `it states ${flagged.map((f) => `"${f}"`).join(", ")}, which the key facts do not give. ` +
  "Every date, day, time and year must come from the key facts, written as given; leave out anything that is not there";

/** Draft a notice and store it as a PENDING suggestion. */
export const draftAnnouncement = async (body, user, { now = new Date() } = {}) => {
  const req = parseDraftRequest(body);
  const [settings, school] = await Promise.all([getAiSettings(), getSchoolSettings()]);
  const maxChars = req.mode === "sms" ? smsLimit(req.length, "GSM") : null;
  const prompt = renderPrompt(ANNOUNCEMENT_PROMPT, {
    schoolName: school?.name,
    shortName: school?.shortName,
    tone: settings.tone,
    mode: req.mode,
    maxChars,
    length: req.length,
    purpose: req.purpose,
    audience: req.audience,
    keyFacts: req.keyFacts,
  });

  let last = null; // the last answer's own check, for a plain refusal
  let result;
  try {
    result = await runJson({
      feature: FEATURE,
      user,
      prompt,
      schema: SCHEMAS[req.mode],
      temperature: 0.4,
      validate: (data) => {
        last = checkDraft(data, req, { now });
        return last.problem || null;
      },
    });
  } catch (error) {
    if (error?.code === "AI_FAILED" && error?.details?.errorClass === "MALFORMED_OUTPUT" && last?.problem) {
      if (last.guard === "DATES") {
        throw new AiAppError(DATE_REFUSAL(last.flagged), 422, "AI_FAILED", { errorClass: "MALFORMED_OUTPUT", guard: "DATES", flagged: last.flagged });
      }
      if (last.guard === "SMS_LENGTH") {
        throw new AiAppError(SMS_REFUSAL(last.chars, last.max, req.length), 422, "AI_FAILED", { errorClass: "MALFORMED_OUTPUT", guard: "SMS_LENGTH" });
      }
    }
    throw error;
  }

  const checked = checkDraft(result.data, req, { now });
  const content = {
    mode: req.mode,
    ...checked.value,
    purpose: req.purpose,
    audience: req.audience,
    keyFacts: req.keyFacts,
    length: req.length,
    ...(req.mode === "news" ? { post: req.post || { audience: "ALL", audienceClassIds: null } } : {}),
  };
  const suggestion = await createSuggestion({
    feature: FEATURE,
    entityType: req.mode === "sms" ? "SMS" : "POST",
    entityId: null,
    field: null,
    content,
    model: result.model,
    promptVersion: result.promptVersion,
    createdBy: actorOf(user),
  });
  return { suggestion, ...(req.mode === "sms" ? { sms: smsInfo(content.text) } : {}) };
};

// ------------------------------------------------------------------ accept
// Only an Administrator can accept (/ai/suggestions/:id/accept is
// Administrator-only), so the post is written as that office login.
const viewerFromActor = (actor) => {
  const m = /^OFFICE:(.+)$/.exec(String(actor || ""));
  if (!m) throw new AppError("Only an office login can use this draft.", 403);
  return { type: "OFFICE", category: "Administrator", username: m[1], teacherId: null };
};

export const acceptAnnouncement = async (suggestion, { transaction, actor }) => {
  const c = suggestion.content || {};
  if (c.mode === "sms") {
    // Never sent from here: the text goes back to the SMS box.
    const text = String(c.text || "").trim();
    return { data: { mode: "sms", text, sms: smsInfo(text) } };
  }
  const viewer = viewerFromActor(actor);
  const postId = await createDraftPostInTransaction(
    {
      title: c.title,
      body: c.body,
      audience: c.post?.audience || "ALL",
      audienceClassIds: c.post?.audience === "CLASSES" ? c.post.audienceClassIds : undefined,
    },
    viewer,
    transaction
  );
  return { entityId: postId, data: { mode: "news", postId, status: "DRAFT" } };
};

export const validateAnnouncementContent = (c) => {
  if (c.mode === "sms") {
    const text = String(c.text ?? "").trim();
    if (!text) return "The SMS needs some text.";
    if (text.length > SMS_TEXT_MAX) return `The SMS can be at most ${SMS_TEXT_MAX} characters.`;
    return null;
  }
  if (c.mode !== "news") return "Unknown kind of notice.";
  const title = String(c.title ?? "").trim();
  const body = String(c.body ?? "").trim();
  if (!title) return "The notice needs a title.";
  if (title.length > POST_LIMITS.title) return `The title can be at most ${POST_LIMITS.title} characters.`;
  if (!body) return "The notice needs some text.";
  if (body.length > POST_LIMITS.body) return `The notice can be at most ${POST_LIMITS.body} characters.`;
  return null;
};

registerAcceptHandler(FEATURE, acceptAnnouncement, { validateContent: validateAnnouncementContent });
