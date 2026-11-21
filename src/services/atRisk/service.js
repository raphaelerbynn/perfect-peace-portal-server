// AI-4: the pupils-at-risk watchlist.
//
//   getWatchlist     the computed list for a term (school-wide or one class):
//                    reasons + figures + risk level per pupil, the AI note
//                    where one was written for the same figures, and the
//                    being-handled / dismissed marks. No AI call: it works
//                    with AI off and over the cap.
//   writeNotes       the AI's short note ("why flagged, suggested next step")
//                    for up to MAX_NOTES pupils without a current note, via
//                    runJson. Any figure not supplied -> rejected (one retry,
//                    then the error; the list is unchanged).
//   setStatus        mark a pupil's entry as being handled / dismissed /
//                    open again, with who and when.
//
// Who (B10): a role holding ai.at_risk. With academics.all_classes (the
// Administrator) school-wide or any one class; without it (the Class Teacher)
// the class the login is linked to only, checked with assertClassAccess.
//
// The notes are NOT drafts (Ai_suggestion): the watchlist is staff-only (the
// head teacher and the pupil's own class teacher), nothing from it reaches
// parents, report cards or the record, and every figure in a note is checked
// against the computed figures. The page labels each note "Written by AI".
import { Op } from "sequelize";
import { AiWatchlistEntry, Class, Student, Term } from "../../models/index.js";
import { AppError } from "../../utils/errorHandling.js";
import { hasPermission, P } from "../../utils/permissions.js";
import { AT_RISK_LENGTHS, AT_RISK_PROMPT, atRiskOutputSchema, renderPrompt } from "../ai/prompts/index.js";
import { featureAllowed, featureBlockReason } from "../ai/gate.js";
import { redactForAi } from "../ai/redact.js";
import { runJson } from "../ai/run.js";
import { actorOf, budgetState } from "../ai/usage.js";
import { assertClassAccess } from "../attendance.js";
import { getBriefingSettings } from "../briefing/settings.js";
import { allowedFigureTokens, unsupportedFigures } from "../briefing/signals.js";
import { listScales, pickScale } from "../grading.js";
import { termLabel } from "../notify.js";
import { getSchoolSettings } from "../school.js";
import { isKgSection } from "../teacherScope.js";
import * as data from "./data.js";
import { DEFAULT_THRESHOLDS, LEVELS, assessPupil, effectiveStatus, fingerprintOf, orderWatchlist, passMarkFromBands } from "./signals.js";

// Most pupils one "Write AI notes" press covers (SchoolPro's watchlist cap).
export const MAX_NOTES = 12;
export const STATUSES = Object.freeze(["OPEN", "HANDLING", "DISMISSED"]);
const STATUS_NOTE_MAX = 300;

const toId = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} must be a whole number`, 400);
  return n;
};
const textOf = (v) => (typeof v === "string" ? v.trim() : "");
// The watchlist itself (the routes check the same key); every class needs academics.all_classes.
const mayUseWatchlist = (user) => hasPermission(user, P.AI_AT_RISK);
const everyClass = (user) => hasPermission(user, P.ALL_CLASSES);

// ------------------------------------------------------------------ scope
/**
 * Which class the caller may see (needs ai.at_risk). With academics.all_classes:
 * the asked class, or every class (null). Without: the class linked to the
 * login only; asking for another is 403.
 * -> { classId, className, own }
 */
export const resolveScope = async (user, classId) => {
  if (!mayUseWatchlist(user)) throw new AppError("You do not have permission to see the watchlist.", 403);
  const asked = classId === undefined || classId === null || classId === "" ? null : toId(classId, "classId");
  if (everyClass(user)) {
    if (asked === null) return { classId: null, className: null, own: false };
    const klass = await Class.findOne({ where: { classId: asked }, attributes: ["classId", "name", "section", "isDeleted"], raw: true });
    if (!klass || klass.isDeleted) throw new AppError("Class not found", 404);
    return { classId: klass.classId, className: String(klass.name ?? "").trim(), own: false };
  }
  if (!user.teacherId) throw new AppError("Your login is not linked to a class. Ask the administrator.", 403);
  const own = await Class.findOne({ where: { teacherId: user.teacherId, isDeleted: { [Op.not]: true } }, attributes: ["classId", "name", "section"], raw: true });
  if (!own) throw new AppError("Your login is not linked to a class. Ask the administrator.", 403);
  if (asked !== null && asked !== Number(own.classId)) throw new AppError("You can only see the watchlist for your own class.", 403);
  await assertClassAccess(user, own.name); // the shared own-class check (same class, by name)
  return { classId: Number(own.classId), className: String(own.name ?? "").trim(), own: true };
};

// ------------------------------------------------------------------ terms
const termOrder = (a, b) => String(a.startDate || "9999").localeCompare(String(b.startDate || "9999")) || Number(a.termId) - Number(b.termId);

/** The term asked for (or the open one) and the one before it (null for the first term). */
export const resolveTerms = async (termId) => {
  const terms = await Term.findAll({ attributes: ["termId", "term", "startDate", "endDate", "active"], raw: true });
  let term;
  if (termId !== undefined && termId !== null && termId !== "") {
    const id = toId(termId, "termId");
    term = terms.find((t) => Number(t.termId) === id);
    if (!term) throw new AppError("Term not found", 404);
  } else {
    term = terms.find((t) => t.active);
    if (!term) throw new AppError("There is no open term. Choose a term.", 400);
  }
  const sorted = [...terms].sort(termOrder);
  const i = sorted.findIndex((t) => Number(t.termId) === Number(term.termId));
  const previous = i > 0 ? sorted[i - 1] : null;
  return { term, previous };
};

const termOut = (t) => (t ? { termId: Number(t.termId), label: termLabel(t.term), startDate: t.startDate || null, endDate: t.endDate || null, active: Boolean(t.active) } : null);

// ------------------------------------------------------------------ the list
const isMissingTable = (e) => (e?.original?.code || e?.parent?.code) === "42P01";

/** The marks and notes for these pupils this term. Before migration 049 is applied: none (the list still works). */
const marksFor = async (termId, ids) => {
  try {
    return await AiWatchlistEntry.findAll({ where: { termId, studentId: { [Op.in]: ids } }, raw: true });
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
};
const statusOut = (row, reasons) => {
  const eff = effectiveStatus(row, reasons);
  return {
    state: eff.state,
    reopened: eff.reopened,
    ...(eff.newKinds ? { newKinds: eff.newKinds } : {}),
    note: row?.statusNote || null,
    by: row?.statusBy || null,
    at: row?.statusAt ? new Date(row.statusAt).toISOString() : null,
    setTo: row?.status || null,
  };
};

const noteOut = (row, fingerprint) =>
  row?.aiNote && row.aiFingerprint === fingerprint
    ? { text: row.aiNote, nextStep: row.aiNextStep, by: row.aiWrittenBy, at: row.aiWrittenAt ? new Date(row.aiWrittenAt).toISOString() : null, model: row.aiModel, promptVersion: row.aiPromptVersion }
    : null;

/**
 * Every pupil in scope assessed for the term, ordered, with marks and notes
 * merged in. -> { term, previousTerm, scope, thresholds, considered, entries }
 */
export const computeWatchlist = async ({ user, termId, classId }) => {
  const scope = await resolveScope(user, classId);
  const { term, previous } = await resolveTerms(termId);
  const briefing = await getBriefingSettings();
  const thresholds = { ...DEFAULT_THRESHOLDS, owingThresholdGhs: Number(briefing?.owingThresholdGhs ?? DEFAULT_THRESHOLDS.owingThresholdGhs) };
  const openTerm = Boolean(term.active);

  const pupils = await data.roster({ classId: scope.classId });
  const ids = pupils.map((p) => p.studentId);
  // One query at a time (the pool is small and this keeps the order of work plain).
  const marks = await data.termMarks({ termId: Number(term.termId), studentIds: ids });
  const before = previous ? await data.termAverages({ termId: Number(previous.termId), studentIds: ids }) : [];
  const attendance = await data.termAttendance({ termId: Number(term.termId), studentIds: ids });
  const recent = openTerm ? await data.recentRegisters({ termId: Number(term.termId), studentIds: ids }) : [];
  const scales = await listScales();
  const rows = ids.length ? await marksFor(Number(term.termId), ids) : [];

  const group = (list) => {
    const m = new Map();
    for (const r of list) m.set(r.studentId, [...(m.get(r.studentId) || []), r]);
    return m;
  };
  const marksOf = group(marks);
  const recentOf = group(recent);
  const beforeOf = new Map(before.map((r) => [r.studentId, r]));
  const attendanceOf = new Map(attendance.map((r) => [r.studentId, r]));
  const rowOf = new Map(rows.map((r) => [Number(r.studentId), r]));
  const passMarkOf = new Map();
  const passMarkFor = (section) => {
    const key = String(section ?? "").trim().toLowerCase();
    if (!passMarkOf.has(key)) passMarkOf.set(key, passMarkFromBands(pickScale(scales, section)?.bands) ?? thresholds.defaultPassMark);
    return passMarkOf.get(key);
  };
  const previousLabel = previous ? termLabel(previous.term) : null;

  const entries = [];
  for (const p of pupils) {
    const isKg = isKgSection(p.section);
    const passMark = passMarkFor(p.section);
    const assessed = assessPupil(
      {
        isKg,
        openTerm,
        owing: p.owing,
        attendance: attendanceOf.get(p.studentId) || { marked: 0, present: 0 },
        recent: recentOf.get(p.studentId) || [],
        marks: marksOf.get(p.studentId) || [],
        previous: beforeOf.get(p.studentId) || null,
        previousTermLabel: previousLabel,
        passMark,
      },
      thresholds
    );
    if (!assessed) continue;
    const fingerprint = fingerprintOf(assessed.reasons);
    const row = rowOf.get(p.studentId);
    entries.push({
      studentId: p.studentId,
      name: p.name,
      firstName: p.firstName,
      classId: p.classId,
      className: p.className,
      section: p.section || null,
      isKg,
      passMark: isKg ? null : passMark,
      riskScore: assessed.riskScore,
      level: assessed.level,
      reasons: assessed.reasons,
      firstAction: assessed.firstAction,
      fingerprint,
      status: statusOut(row, assessed.reasons),
      note: noteOut(row, fingerprint),
    });
  }

  return {
    term: termOut(term),
    previousTerm: termOut(previous),
    scope,
    thresholds,
    considered: pupils.length,
    entries: orderWatchlist(entries),
  };
};

const csv = (v) =>
  String(v ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

/** What the caller's AI button can do now (no amounts: the page asks /ai/status for those). */
export const aiStateFor = async (user) => {
  if (!featureAllowed("AT_RISK", user)) return { available: false, reason: "ROLE" };
  let reason = await featureBlockReason("AT_RISK");
  if (!reason && (await budgetState()).overCap) reason = "QUOTA";
  return { available: !reason, reason };
};

/**
 * GET /ai/watchlist?termId&classId&level=HIGH,MEDIUM&status=OPEN,HANDLING
 * Counts are over everything in scope; the filters narrow `entries` only.
 * Default status filter: open + being handled (dismissed hidden).
 */
export const getWatchlist = async ({ user, query = {} }) => {
  const list = await computeWatchlist({ user, termId: query.termId, classId: query.classId });
  const levels = csv(query.level).filter((l) => LEVELS.includes(l));
  const statuses = query.status === "ALL" ? STATUSES : csv(query.status || "OPEN,HANDLING").filter((s) => STATUSES.includes(s));
  const counts = {
    total: list.entries.length,
    byLevel: Object.fromEntries(LEVELS.map((l) => [l, list.entries.filter((e) => e.level === l).length])),
    byStatus: Object.fromEntries(STATUSES.map((s) => [s, list.entries.filter((e) => e.status.state === s).length])),
    withNote: list.entries.filter((e) => e.note).length,
  };
  const entries = list.entries.filter((e) => (!levels.length || levels.includes(e.level)) && (!statuses.length || statuses.includes(e.status.state)));
  return { ...list, counts, filters: { level: levels, status: statuses }, entries, ai: await aiStateFor(user) };
};

// ------------------------------------------------------------------ the AI note
/** What the model sees for one pupil: first name, class, reasons and figures. No ids, no contact data. */
const pupilForAi = (e, key) => ({
  key,
  firstName: e.firstName || "the pupil",
  className: e.className,
  level: e.level,
  reasons: e.reasons.map((r) => ({ kind: r.kind, statement: r.statement, figures: r.figures })),
  suggestedFirstStep: e.firstAction,
});

const lengthProblem = (value, [min, max], what) => (value.length < min || value.length > max ? `${what} must be ${min} to ${max} characters` : null);

/**
 * The check on the model's answer: every entry tied to a pupil we sent (once),
 * lengths, and every number in a pupil's note found in THAT pupil's figures.
 * -> problem text or null. Pupils left out are allowed (no note for them).
 */
export const notesProblem = (d, { pupils, termLabel: label }) => {
  if (!d || typeof d !== "object" || !Array.isArray(d.pupils)) return "the answer must have a pupils list";
  if (!d.pupils.length) return "write an entry for each pupil";
  const byKey = new Map(pupils.map((p) => [p.key, p]));
  const seen = new Set();
  for (const item of d.pupils) {
    const key = textOf(item?.key);
    const pupil = byKey.get(key);
    if (!pupil) return `an entry was written for pupil "${key}", who was not sent`;
    if (seen.has(key)) return `pupil "${key}" was written up twice`;
    seen.add(key);
    // The key itself ("P3") is not a figure the note may quote.
    const { key: _key, ...facts } = pupil;
    const allowed = allowedFigureTokens({ facts, termLabel: label });
    for (const [value, bounds, what] of [
      [textOf(item.note), AT_RISK_LENGTHS.note, `the note for "${key}"`],
      [textOf(item.nextStep), AT_RISK_LENGTHS.nextStep, `the next step for "${key}"`],
    ]) {
      const lp = lengthProblem(value, bounds, what);
      if (lp) return lp;
      const bad = unsupportedFigures(value, allowed);
      if (bad.length) return `${what} quotes figures that were not supplied: ${bad.slice(0, 5).join(", ")}`;
    }
  }
  return null;
};

/**
 * POST /ai/watchlist/notes { termId, classId?, studentIds? }
 * Writes notes for up to MAX_NOTES pupils in scope that have none for their
 * current figures (most at risk first; dismissed pupils skipped). Nothing to
 * write -> no AI call. -> { written, remaining, list }
 */
export const writeNotes = async ({ user, body = {} }) => {
  const list = await computeWatchlist({ user, termId: body.termId, classId: body.classId });
  const wanted = Array.isArray(body.studentIds) ? new Set(body.studentIds.map(Number).filter(Number.isInteger)) : null;
  const needing = list.entries.filter((e) => !e.note && e.status.state !== "DISMISSED" && (!wanted || wanted.has(e.studentId)));
  const batch = needing.slice(0, MAX_NOTES);
  if (!batch.length) return { written: 0, remaining: 0, model: null, promptVersion: null };

  const keyed = batch.map((e, i) => ({ entry: e, key: `P${i + 1}` }));
  const pupils = redactForAi(keyed.map(({ entry, key }) => pupilForAi(entry, key)));
  const label = list.term.label;
  const school = await getSchoolSettings().catch(() => ({}));
  const prompt = renderPrompt(AT_RISK_PROMPT, { schoolName: school?.name || "the school", termLabel: label, pupils });
  const res = await runJson({
    feature: "AT_RISK",
    user,
    prompt,
    schema: atRiskOutputSchema(batch.length),
    validate: (d) => notesProblem(d, { pupils, termLabel: label }),
    temperature: 0.2,
  });

  const byKey = new Map(keyed.map((k) => [k.key, k.entry]));
  const now = new Date();
  const by = actorOf(user);
  let written = 0;
  for (const item of res.data.pupils) {
    const entry = byKey.get(textOf(item.key));
    if (!entry) continue;
    await AiWatchlistEntry.upsert({
      studentId: entry.studentId,
      termId: list.term.termId,
      aiNote: textOf(item.note),
      aiNextStep: textOf(item.nextStep),
      aiFingerprint: entry.fingerprint,
      aiModel: res.model ? String(res.model).slice(0, 60) : null,
      aiPromptVersion: res.promptVersion ? String(res.promptVersion).slice(0, 60) : null,
      aiWrittenBy: by,
      aiWrittenAt: now,
      updatedAt: now,
    });
    written += 1;
  }
  return { written, remaining: Math.max(0, needing.length - written), model: res.model, promptVersion: res.promptVersion };
};

// ------------------------------------------------------------------ handled / dismissed
/**
 * PUT /ai/watchlist/:studentId/status { termId?, status: OPEN|HANDLING|DISMISSED, note? }
 * Records who and when. The reasons the pupil has now are kept with it, so a
 * NEW reason later puts a dismissed pupil back on the open list.
 */
export const setStatus = async ({ user, studentId, body = {} }) => {
  const id = toId(studentId, "studentId");
  const status = String(body.status ?? "").trim().toUpperCase();
  if (!STATUSES.includes(status)) throw new AppError("status must be OPEN, HANDLING or DISMISSED", 400);
  const note = textOf(body.note);
  if (note.length > STATUS_NOTE_MAX) throw new AppError(`The note can be at most ${STATUS_NOTE_MAX} characters`, 400);

  const pupil = await Student.findOne({ where: { studentId: id }, attributes: ["studentId", "classId", "isDeleted"], raw: true });
  if (!pupil || pupil.isDeleted) throw new AppError("Pupil not found", 404);
  // Scope: the pupil's class must be one the caller may see.
  if (!everyClass(user)) {
    const scope = await resolveScope(user, null);
    if (Number(pupil.classId) !== Number(scope.classId)) throw new AppError("You can only act on pupils in your own class.", 403);
  }
  const list = await computeWatchlist({ user, termId: body.termId, classId: everyClass(user) ? pupil.classId : null });
  const entry = list.entries.find((e) => e.studentId === id);
  const now = new Date();
  await AiWatchlistEntry.upsert({
    studentId: id,
    termId: list.term.termId,
    status: status === "OPEN" ? null : status,
    statusNote: status === "OPEN" ? null : note || null,
    statusKinds: entry ? entry.reasons.map((r) => r.kind) : [],
    statusBy: actorOf(user),
    statusAt: now,
    updatedAt: now,
  });
  const row = await AiWatchlistEntry.findOne({ where: { studentId: id, termId: list.term.termId }, raw: true });
  return { studentId: id, termId: list.term.termId, onWatchlist: Boolean(entry), status: statusOut(row, entry?.reasons || []) };
};
