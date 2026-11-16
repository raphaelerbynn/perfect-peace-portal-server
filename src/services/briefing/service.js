// AI-5: the Monday briefing. One per chosen day (Ai_briefing, run_key = the
// Africa/Accra date), made by the scheduler or "Run now".
//
//   1. Claim the day (insert the row RUNNING; the UNIQUE run_key means a
//      restart or a second instance can't make two).
//   2. Measure the signals in SQL (data.js) and decide what is news
//      (signals.js). Term-scoped news said in the last 8 briefings isn't
//      repeated.
//   3. Nothing crossed a line -> QUIET: no AI call, no cost, nobody notified.
//   4. Otherwise the model ranks and words the signals (runJson, redacted,
//      metered). Any figure it wasn't given -> rejected (one retry, then the
//      plain list). Over the cap / AI off / AI failed -> the plain list of
//      computed statements, marked source PLAIN with the reason.
//   5. Deliver a READY briefing: the in-app bell for Administrators (B16), and
//      the head teacher's email and/or WhatsApp if chosen in the settings.
//      Recipient address / number go only to those providers, never the AI.
//
// Run now (Administrator) REPLACES today's briefing in place (history keeps
// one row per day) and delivers it again. A day already being made -> 409.
import { Op } from "sequelize";
import { AiBriefing, Term, UserAccount } from "../../models/index.js";
import { AppError } from "../../utils/errorHandling.js";
import { round2, toNum } from "../../utils/money.js";
import { parsePagination } from "../../utils/pagination.js";
import { renderNotificationEmail } from "../../utils/emailTemplate.js";
import { BRIEFING_LENGTHS, BRIEFING_PROMPT, briefingOutputSchema, renderPrompt } from "../ai/prompts/index.js";
import { redactForAi } from "../ai/redact.js";
import { runJson } from "../ai/run.js";
import { actorOf } from "../ai/usage.js";
import { absoluteLink, findMissingScores, notify, sendEmailBatch, termLabel } from "../notify.js";
import { isEmail, maskEmail } from "../mailer.js";
import { getSchoolSettings } from "../school.js";
import { maskWhatsAppNumber, sendWhatsApp } from "../whatsapp.js";
import * as data from "./data.js";
import { BRIEFING_TZ, accraParts, addDays, daysBetween } from "./schedule.js";
import { getBriefingSettings } from "./settings.js";
import {
  DEFAULT_THRESHOLDS,
  MAX_ITEMS,
  MAX_SIGNALS,
  allowedFigureTokens,
  attendanceDipSignal,
  chronicAbsenceSignal,
  collectionDropSignal,
  groupChronicSignals,
  owingSignal,
  plainItems,
  rankSignals,
  resultsGapsSignal,
  staffAbsenceSignal,
  unmarkedRegistersSignal,
  unsupportedFigures,
} from "./signals.js";

export const BRIEFING_LINK = "/briefings";
// A RUNNING row older than this is a run that died (crash, restart): reclaimable.
export const STALE_RUN_MS = 15 * 60 * 1000;
// Briefings read back for "already said" (term-scoped keys).
export const LOOKBACK = 8;
// Quiet days notify nobody (SchoolPro's rule: a digest that cries wolf is ignored).
export const NOTIFY_QUIET = false;

const FALLBACK_TEXT = {
  QUOTA: "This month's AI budget is used up, so this briefing lists the figures as measured, without AI.",
  AI_OFF: "AI is switched off, so this briefing lists the figures as measured, without AI.",
  AI_FAILED: "The AI's write-up couldn't be used (it could not be checked against the figures), so this briefing lists the figures as measured.",
};

const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const isUniqueError = (e) => e?.name === "SequelizeUniqueConstraintError" || (e?.original?.code || e?.parent?.code) === "23505";

// ------------------------------------------------------------------ the window
/**
 * The 7 days before the briefing day, the 4 weeks before that, and the open
 * term (the attendance baseline stays inside the term, so the first weeks of a
 * term have no baseline and say nothing about dips).
 */
export const windowFor = (date, term = null, t = DEFAULT_THRESHOLDS) => {
  const weekStart = addDays(date, -7);
  const baselineStart = addDays(weekStart, -7 * t.baselineWeeks);
  const termStart = term?.startDate ? String(term.startDate).slice(0, 10) : null;
  const termEnd = term?.endDate ? String(term.endDate).slice(0, 10) : null;
  return {
    timeZone: BRIEFING_TZ,
    date,
    weekStart,
    weekEnd: date, // exclusive
    lastDay: addDays(date, -1),
    baselineStart,
    baselineWeeks: t.baselineWeeks,
    attendanceBaselineStart: termStart && termStart > baselineStart ? termStart : baselineStart,
    termId: term?.termId ?? null,
    termLabel: term ? termLabel(term.term) : null,
    termStart,
    termEnd,
    daysToEnd: termEnd ? daysBetween(date, termEnd) : null,
  };
};

// ------------------------------------------------------------------ signals
/**
 * Every signal, measured. A collector that fails (e.g. a table missing) is
 * skipped and named in `skipped`; if they all fail the briefing FAILS.
 * -> { signals, skipped: [{ kind, error }] }
 */
export const collectSignals = async (window, settings) => {
  const t = { ...DEFAULT_THRESHOLDS, owingThresholdGhs: settings.owingThresholdGhs };
  const signals = [];
  const skipped = [];
  const inTerm = window.termId != null;
  const run = async (kind, fn) => {
    try {
      const out = await fn();
      for (const s of [].concat(out || [])) if (s) signals.push(s);
    } catch (e) {
      console.error(`[briefing] ${kind} not measured: ${e?.message || e}`);
      skipped.push({ kind, error: clip(e?.message || String(e), 200) });
    }
  };

  // Attendance (this term only: a holiday has no registers anyway).
  if (inTerm) {
    await run("ATTENDANCE_DIP", async () =>
      (await data.attendanceByClass({ weekStart: window.weekStart, weekEnd: window.weekEnd, baselineStart: window.attendanceBaselineStart })).map((r) =>
        attendanceDipSignal(r, window, t)
      )
    );
    await run("CHRONIC_ABSENCE", async () =>
      (await data.absenceByPupil({ termId: window.termId, weekStart: window.weekStart, weekEnd: window.weekEnd })).map((r) => chronicAbsenceSignal(r, window.termId, t))
    );
    await run("UNMARKED_REGISTERS", async () => {
      const { schoolDays, rows } = await data.unmarkedRegisters({ weekStart: window.weekStart, weekEnd: window.weekEnd, termStart: window.termStart });
      return unmarkedRegistersSignal(rows, schoolDays, window, t);
    });
    // Fees taken: in term time only (holiday takings are naturally low).
    await run("COLLECTION_DROP", async () => collectionDropSignal(await data.feesByWeek({ weekEnd: window.weekEnd, baselineStart: window.baselineStart }), window, t));
    await run("RESULTS_GAPS", async () =>
      resultsGapsSignal(await findMissingScores(window.termId), { termId: window.termId, termLabel: window.termLabel, daysToEnd: window.daysToEnd, date: window.date }, t)
    );
  }
  await run("OWING", async () => owingSignal(await data.owingSummary({ threshold: t.owingThresholdGhs }), window.termId, t));
  await run("STAFF_ABSENCE", async () => (await data.staffAbsences({ weekStart: window.weekStart, weekEnd: window.weekEnd })).map((r) => staffAbsenceSignal(r, window, t)));

  const attempted = inTerm ? 7 : 2;
  if (skipped.length === attempted) {
    throw new Error(`No figures could be read (${skipped.map((s) => s.kind).join(", ")})`);
  }
  return { signals: rankSignals(signals), skipped };
};

/** Signal keys the last few briefings (before this day) already carried. */
export const recentKeys = async (date) => {
  const rows = await AiBriefing.findAll({
    where: { briefingDate: { [Op.lt]: date }, status: "READY" },
    order: [["briefingDate", "DESC"]],
    limit: LOOKBACK,
    attributes: ["content"],
    raw: true,
  });
  const keys = new Set();
  for (const r of rows) {
    for (const item of r.content?.items || []) {
      if (item?.signalKey) keys.add(item.signalKey);
      for (const k of item?.memberKeys || []) keys.add(k);
    }
  }
  return keys;
};

// ------------------------------------------------------------------ the AI's write-up
const textOf = (v) => (typeof v === "string" ? v.trim() : "");
const lengthProblem = (value, [min, max], what) => (value.length < min || value.length > max ? `${what} must be ${min} to ${max} characters` : null);

/**
 * The check on the model's answer: lengths, every item tied to a signal we
 * sent (once), and every figure supplied. Headline and summary may draw on the
 * whole shortlist; each item only on its own signal. -> problem text or null.
 */
export const briefingProblem = (d, { signals, window, today, maxItems }) => {
  if (!d || typeof d !== "object" || !Array.isArray(d.items)) return "the answer must have a headline, a summary and items";
  const headline = textOf(d.headline);
  const summary = textOf(d.summary);
  const p = lengthProblem(headline, BRIEFING_LENGTHS.headline, "the headline") || lengthProblem(summary, BRIEFING_LENGTHS.summary, "the summary");
  if (p) return p;
  const everything = allowedFigureTokens({ signals, window, today, count: signals.length });
  for (const [value, what] of [[headline, "the headline"], [summary, "the summary"]]) {
    const bad = unsupportedFigures(value, everything);
    if (bad.length) return `${what} quotes figures that were not supplied: ${bad.slice(0, 5).join(", ")}`;
  }
  if (!d.items.length) return "write at least one item";
  if (d.items.length > maxItems) return `at most ${maxItems} items`;
  const byKey = new Map(signals.map((s) => [s.signalKey, s]));
  const seen = new Set();
  for (const item of d.items) {
    const key = textOf(item?.signalKey);
    const signal = byKey.get(key);
    if (!signal) return `an item was written for signal "${key}", which was not sent`;
    if (seen.has(key)) return `signal "${key}" was written up twice`;
    seen.add(key);
    const fields = [
      [textOf(item.headline), BRIEFING_LENGTHS.itemHeadline, `the headline for "${key}"`],
      [textOf(item.body), BRIEFING_LENGTHS.itemBody, `the body for "${key}"`],
      [textOf(item.whatToDoNext), BRIEFING_LENGTHS.itemAction, `the next step for "${key}"`],
    ];
    const allowed = allowedFigureTokens({ signal, window, today });
    for (const [value, bounds, what] of fields) {
      const lp = lengthProblem(value, bounds, what);
      if (lp) return lp;
      const bad = unsupportedFigures(value, allowed);
      if (bad.length) return `${what} quotes figures that were not supplied: ${bad.slice(0, 5).join(", ")}`;
    }
  }
  return null;
};

const longDate = (date) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The model's write-up. Throws the AI error (quota, off, failed) for the caller to fall back. */
const writeWithAi = async ({ shortlist, window, school, user }) => {
  const maxItems = Math.min(MAX_ITEMS, shortlist.length);
  // What the model sees: no ids beyond the key, no contact data (redactForAi
  // drops any contact-shaped key and scrubs phone numbers / emails in text).
  const signals = redactForAi(shortlist.map((s) => ({ signalKey: s.key, kind: s.kind, subject: s.subject, statement: s.statement, figures: s.figures })));
  const promptWindow = { from: window.weekStart, to: window.lastDay, baselineWeeks: window.baselineWeeks, termLabel: window.termLabel };
  const today = longDate(window.date);
  const prompt = renderPrompt(BRIEFING_PROMPT, { schoolName: school?.name || "the school", today, window: promptWindow, signals, maxItems });
  const res = await runJson({
    feature: "BRIEFING",
    user,
    prompt,
    schema: briefingOutputSchema(maxItems),
    validate: (d) => briefingProblem(d, { signals, window: promptWindow, today, maxItems }),
    temperature: 0.2,
  });
  const bySignal = new Map(shortlist.map((s) => [s.key, s]));
  const items = res.data.items.map((i) => {
    const s = bySignal.get(textOf(i.signalKey));
    return {
      signalKey: s.key,
      ...(s.memberKeys ? { memberKeys: s.memberKeys } : {}),
      kind: s.kind,
      headline: textOf(i.headline),
      body: textOf(i.body),
      whatToDoNext: textOf(i.whatToDoNext),
      statement: s.statement,
      figures: s.figures,
    };
  });
  return { headline: textOf(res.data.headline), summary: textOf(res.data.summary), items, model: res.model, promptVersion: res.promptVersion, costGhs: res.costGhs || 0 };
};

const fallbackReasonOf = (e) => {
  if (e?.code === "AI_QUOTA") return "QUOTA";
  if (e?.code === "AI_DISABLED") return "AI_OFF";
  return "AI_FAILED";
};

const plainBriefing = (shortlist, reason) => {
  const n = shortlist.length;
  return {
    headline: n === 1 ? `One thing to look at: ${shortlist[0].subject}` : `${n} things to look at this week`,
    summary: FALLBACK_TEXT[reason],
    items: plainItems(shortlist),
  };
};

// ------------------------------------------------------------------ build one briefing
/**
 * Measure and write the briefing for `date` (no database writes of its own).
 * -> { status, source, fallbackReason, signals, content, model, promptVersion, costGhs }
 */
export const buildBriefing = async ({ date, user = null }) => {
  const settings = await getBriefingSettings();
  const term = await Term.findOne({ where: { active: true }, raw: true });
  const window = windowFor(date, term);
  const school = await getSchoolSettings().catch(() => ({}));
  const { signals: detected, skipped } = await collectSignals(window, settings);
  const said = await recentKeys(date);
  const fresh = groupChronicSignals(detected.filter((s) => !said.has(s.key)), window.termId, date);
  const suppressedCount = detected.filter((s) => said.has(s.key)).length;
  const storedSignals = detected.map((s) => ({ ...s, suppressed: said.has(s.key) }));
  const base = {
    window: { from: window.weekStart, to: window.lastDay, date, timeZone: window.timeZone, baselineWeeks: window.baselineWeeks, termId: window.termId, termLabel: window.termLabel },
    signalCount: fresh.length,
    suppressedCount,
    skipped,
    generatedAt: new Date().toISOString(),
  };

  if (!fresh.length) {
    return {
      status: "QUIET",
      source: null,
      fallbackReason: null,
      signals: storedSignals,
      content: {
        ...base,
        mode: "QUIET",
        headline: "A quiet week. Nothing crossed a line.",
        summary:
          `Attendance, registers, fee payments, pupils owing, scores and staff attendance were all within their usual range for ${window.weekStart} to ${window.lastDay}.` +
          (suppressedCount ? ` ${suppressedCount} thing(s) already reported in a recent briefing are not repeated.` : "") +
          " No AI was used and nothing was spent.",
        items: [],
        consideredCount: 0,
        model: null,
        promptVersion: null,
      },
      model: null,
      promptVersion: null,
      costGhs: 0,
    };
  }

  const shortlist = fresh.slice(0, MAX_SIGNALS);
  let written;
  let source = "AI";
  let fallbackReason = null;
  try {
    written = await writeWithAi({ shortlist, window, school, user });
  } catch (e) {
    fallbackReason = fallbackReasonOf(e);
    if (fallbackReason === "AI_FAILED") console.warn(`[briefing] AI write-up not used (${date}): ${e?.message || e}`);
    source = "PLAIN";
    written = { ...plainBriefing(shortlist, fallbackReason), model: null, promptVersion: null, costGhs: 0 };
  }
  return {
    status: "READY",
    source,
    fallbackReason,
    signals: storedSignals,
    content: {
      ...base,
      mode: "FULL",
      source,
      fallbackReason,
      headline: written.headline,
      summary: written.summary,
      items: written.items,
      consideredCount: shortlist.length,
      model: written.model,
      promptVersion: written.promptVersion,
    },
    model: written.model,
    promptVersion: written.promptVersion,
    costGhs: written.costGhs,
  };
};

// ------------------------------------------------------------------ delivery
/** Plain text for email / WhatsApp. */
export const briefingText = (content, { schoolName, date, url } = {}) => {
  const lines = [`${schoolName ? `${schoolName}: ` : ""}briefing for ${longDate(date)}`, "", content.headline, "", content.summary];
  (content.items || []).forEach((item, i) => {
    lines.push("", `${i + 1}. ${item.headline}`, item.body, `Next: ${item.whatToDoNext}`);
  });
  if (url) lines.push("", `Open it in the office app: ${url}`);
  return lines.join("\n");
};

const officeAdmins = async () =>
  (await UserAccount.findAll({ where: { category: "Administrator", isDeleted: { [Op.not]: true } }, attributes: ["username"], raw: true }))
    .map((u) => u.username)
    .filter(Boolean);

/**
 * Deliver a READY briefing on the chosen channels. Never throws: each
 * channel's result is recorded. -> delivered JSON
 */
export const deliverBriefing = async (row, settings) => {
  const content = row.content || {};
  const delivered = { at: new Date().toISOString(), inApp: 0, email: null, whatsapp: null };
  if (row.status !== "READY" && !(NOTIFY_QUIET && row.status === "QUIET")) return { ...delivered, skipped: row.status };

  try {
    const admins = await officeAdmins();
    const res = await notify({
      type: "AI_BRIEFING",
      recipients: admins.map((u) => ({ type: "OFFICE", id: u })),
      title: clip(content.headline || "Monday briefing", 200),
      body: [content.summary, ...(content.items || []).map((i) => `• ${i.headline}`)].filter(Boolean).join("\n"),
      link: BRIEFING_LINK,
      entity: { type: "briefing", id: row.runKey },
    });
    delivered.inApp = res.inApp;
  } catch (e) {
    console.error(`[briefing] in-app notice failed: ${e?.message || e}`);
  }

  const school = await getSchoolSettings().catch(() => ({}));
  const url = absoluteLink("OFFICE", BRIEFING_LINK);
  const text = briefingText(content, { schoolName: school?.name, date: row.briefingDate, url });

  if (settings.emailEnabled && isEmail(settings.emailTo)) {
    try {
      const mail = renderNotificationEmail({ school, title: clip(content.headline || "Monday briefing", 150), body: briefingText(content, { date: row.briefingDate }), url });
      const counts = await sendEmailBatch("AI_BRIEFING", [{ to: settings.emailTo, recipient: null, ...mail }]);
      const status = counts.sent ? "SENT" : counts.logged ? "LOGGED" : counts.failed ? "FAILED" : "OFF";
      delivered.email = { status, to: maskEmail(settings.emailTo) };
    } catch (e) {
      delivered.email = { status: "FAILED", to: maskEmail(settings.emailTo), error: clip(e?.message, 200) };
    }
  }
  if (settings.whatsappEnabled && settings.whatsappTo) {
    const res = await sendWhatsApp({ to: settings.whatsappTo, text });
    delivered.whatsapp = { status: res.status, to: maskWhatsAppNumber(settings.whatsappTo), ...(res.error ? { error: res.error } : {}) };
    if (res.status === "FAILED") console.warn(`[briefing] WhatsApp not sent: ${res.error}`);
  }
  return delivered;
};

// ------------------------------------------------------------------ run (claim, build, store, deliver)
const staleBefore = (now) => new Date(now.getTime() - STALE_RUN_MS);

/**
 * Claim `date` for this process. Scheduled: only if no briefing exists for the
 * day (or its run died). Manual (Run now): replaces the day's briefing unless
 * it is being made right now (409). -> true when claimed.
 */
export const claimDay = async (date, { trigger, runBy, now = new Date() }) => {
  const fresh = { runKey: date, briefingDate: date, status: "RUNNING", source: null, fallbackReason: null, signals: [], content: null, delivered: {}, costGhs: 0, error: null, runTrigger: trigger, runBy, createdAt: now, updatedAt: now };
  try {
    await AiBriefing.create(fresh);
    return true;
  } catch (e) {
    if (!isUniqueError(e)) throw e;
  }
  const reclaim = trigger === "MANUAL"
    ? { [Op.or]: [{ status: { [Op.ne]: "RUNNING" } }, { updatedAt: { [Op.lt]: staleBefore(now) } }] }
    : { status: "RUNNING", updatedAt: { [Op.lt]: staleBefore(now) } };
  const [count] = await AiBriefing.update(
    { status: "RUNNING", runTrigger: trigger, runBy, error: null, updatedAt: now },
    { where: { runKey: date, ...reclaim } }
  );
  if (count) return true;
  if (trigger === "MANUAL") throw new AppError("Today's briefing is being made right now. Try again in a minute.", 409);
  return false;
};

/**
 * Make (or, for Run now, remake) the briefing for the Accra date of `now`.
 * -> the stored briefing, or { skipped: "ALREADY_DONE" } for a scheduled run
 * whose day is already made / being made elsewhere.
 */
export const runBriefing = async ({ now = new Date(), trigger = "SCHEDULE", user = null } = {}) => {
  const date = accraParts(now).date;
  const runBy = actorOf(user);
  const claimed = await claimDay(date, { trigger, runBy, now });
  if (!claimed) return { skipped: "ALREADY_DONE", date };

  let result;
  try {
    result = await buildBriefing({ date, user });
  } catch (e) {
    console.error(`[briefing] ${date} failed:`, e?.message || e);
    await AiBriefing.update(
      { status: "FAILED", source: null, fallbackReason: null, content: null, signals: [], error: clip(e?.message || String(e), 300), updatedAt: new Date() },
      { where: { runKey: date } }
    );
    return getBriefingByDate(date);
  }

  await AiBriefing.update(
    {
      status: result.status,
      source: result.source,
      fallbackReason: result.fallbackReason,
      signals: result.signals,
      content: result.content,
      model: result.model,
      promptVersion: result.promptVersion,
      costGhs: round2(result.costGhs || 0),
      error: null,
      delivered: {},
      updatedAt: new Date(),
    },
    { where: { runKey: date } }
  );
  const settings = await getBriefingSettings();
  const delivered = await deliverBriefing({ runKey: date, briefingDate: date, status: result.status, content: result.content }, settings);
  await AiBriefing.update({ delivered, updatedAt: new Date() }, { where: { runKey: date } });
  return getBriefingByDate(date);
};

// ------------------------------------------------------------------ reads
export const serializeBriefing = (r, { full = true } = {}) =>
  r && {
    briefingId: r.briefingId,
    date: r.briefingDate ? String(r.briefingDate).slice(0, 10) : null,
    status: r.status,
    source: r.source ?? null,
    fallbackReason: r.fallbackReason ?? null,
    headline: r.content?.headline ?? null,
    summary: r.content?.summary ?? null,
    itemCount: r.content?.items?.length ?? 0,
    trigger: r.runTrigger,
    runBy: r.runBy ? String(r.runBy).replace(/^OFFICE:/, "") : null,
    costGhs: round2(toNum(r.costGhs || 0)),
    error: r.error ?? null,
    delivered: r.delivered || {},
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    ...(full ? { content: r.content || null, signals: r.signals || [], model: r.model ?? null, promptVersion: r.promptVersion ?? null } : {}),
  };

export const getBriefingByDate = async (date) => serializeBriefing(await AiBriefing.findOne({ where: { runKey: date }, raw: true }));

export const getBriefing = async (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("Briefing not found", 404);
  const row = await AiBriefing.findOne({ where: { briefingId: n }, raw: true });
  if (!row) throw new AppError("Briefing not found", 404);
  return serializeBriefing(row);
};

/** The newest finished briefing, plus whether today's is being made now. */
export const latestBriefing = async (now = new Date()) => {
  const row = await AiBriefing.findOne({
    where: { status: { [Op.ne]: "RUNNING" } },
    order: [["briefingDate", "DESC"], ["briefingId", "DESC"]],
    raw: true,
  });
  const today = await AiBriefing.findOne({ where: { runKey: accraParts(now).date }, attributes: ["status", "updatedAt"], raw: true });
  const running = Boolean(today && today.status === "RUNNING" && new Date(today.updatedAt) >= staleBefore(now));
  return { briefing: serializeBriefing(row), running };
};

export const listBriefings = async (query = {}) => {
  const paging = parsePagination({ page: query.page, limit: query.limit || 20 }, { maxLimit: 100 });
  const { rows, count } = await AiBriefing.findAndCountAll({
    where: { status: { [Op.ne]: "RUNNING" } },
    order: [["briefingDate", "DESC"], ["briefingId", "DESC"]],
    limit: paging.limit,
    offset: paging.offset,
    raw: true,
  });
  return { briefings: rows.map((r) => serializeBriefing(r, { full: false })), total: count, page: paging.page, limit: paging.limit, totalPages: Math.ceil(count / paging.limit) };
};
