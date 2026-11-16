// AI-3: the AI half of question papers (ported from SchoolPro
// ai/generation/question-set.service.ts). Every model call goes through
// services/ai/run.js (switches, cap, usage log, friendly errors).
//
//   generateSection   one section (at most 20 items) -> validated -> the blind
//                     checker pass answers the objective items without the key
//                     -> stored as an Ai_suggestion draft (one open draft per
//                     section; an older open one is discarded).
//   regenerateItem    one item of an open draft, checked the same way.
//   saveDraft         the teacher's edits to a draft (still a draft; edited
//                     items are marked and become AI_EDITED when accepted).
//   acceptSection     a section with a draft: accepting the draft replaces the
//                     section's questions with it (accept handler below); a
//                     section without one: papers.markSectionAccepted.
//   discardDraft      reject the draft; nothing is written.
//
// The draft never becomes questions without the teacher's accept. Accepting,
// editing and discarding drafts work with AI switched off (drafts already
// waiting are never stranded); generating and regenerating need it on.
import { randomBytes } from "crypto";
import { AiSuggestion, Class, Question, QuestionPaper, Subject } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import sequelize from "../config/database.js";
import { renderPrompt } from "./ai/prompts/registry.js";
import { ANSWER_CHECK_SCHEMA, QUESTION_CHECK_PROMPT, QUESTION_SECTION_PROMPT, QUESTION_SECTION_SCHEMA } from "./ai/prompts/questionPaper.js";
import { runJson } from "./ai/run.js";
import { acceptSuggestion, createSuggestion, editSuggestion, getSuggestion, registerAcceptHandler, rejectSuggestion } from "./ai/suggestions.js";
import { actorOf } from "./ai/usage.js";
import { getSchoolSettings } from "./school.js";
import {
  answerChanged,
  compareAnswer,
  contentChanged,
  isObjective,
  levelBandFor,
  normaliseStem,
  QuestionValidationError,
  round2,
  sectionProblem,
  validateGeneratedSection,
  validateQuestion,
} from "./paperRules.js";
import {
  assertDraft,
  getMyPaper,
  loadOwnPaper,
  markSectionAccepted,
  OPEN_DRAFT,
  PAPER_ENTITY,
  sectionField,
  sectionLetter,
  sectionOfField,
  termLabel,
} from "./papers.js";
import { Term } from "../models/index.js";

const GENERATION_TEMPERATURE = 0.6;
const newKey = () => `q${randomBytes(5).toString("hex")}`;
const teacherIdOf = (user) => Number(user?.id);
const specOf = (paper) => (paper.spec && Array.isArray(paper.spec.sections) ? paper.spec : { topics: [], sections: [] });

const sectionOf = (paper, n) => {
  const num = Number(n);
  const s = Number.isInteger(num) ? specOf(paper).sections[num - 1] : null;
  if (!s) throw new AppError("Section not found on this paper.", 404);
  return { n: num, s };
};

/** The request the section prompt carries. No pupil data. */
export const buildContext = async (paper, n, section, { count, avoidStems = [], note = null } = {}) => {
  const [subject, klass, term] = await Promise.all([
    Subject.findOne({ where: { subjectId: paper.subjectId }, attributes: ["name"], raw: true }),
    Class.findOne({ where: { classId: paper.classId }, attributes: ["name", "section"], raw: true }),
    Term.findOne({ where: { termId: paper.termId }, attributes: ["term"], raw: true }),
  ]);
  const spec = specOf(paper);
  const subjectName = subject?.name || "the subject";
  const className = klass?.name || "the class";
  const teacherNote = [spec.note, note].map((x) => String(x || "").trim()).filter(Boolean).join(" ").slice(0, 800) || null;
  return {
    subjectName,
    className,
    levelBand: levelBandFor(className, klass?.section),
    termName: termLabel(term) || "this term",
    topics: spec.topics?.length ? spec.topics : [`${subjectName} for ${className}`],
    section: {
      number: n,
      title: section.title || `Section ${sectionLetter(n)}`,
      type: section.type,
      count: count ?? section.count,
      marksEach: section.marksEach,
      difficulty: section.difficulty || "MIXED",
    },
    teacherNote,
    avoidStems: avoidStems.slice(0, 80),
  };
};

/** One generation call; runJson retries once when our validator refuses the answer. */
const callGeneration = async (user, context, typeMarks, count) => {
  const school = await getSchoolSettings().catch(() => null);
  const prompt = renderPrompt(QUESTION_SECTION_PROMPT, { schoolName: school?.name, context });
  const { data, model, promptVersion } = await runJson({
    feature: "PAPERS",
    user,
    prompt,
    schema: QUESTION_SECTION_SCHEMA,
    validate: (d) => sectionProblem(d, typeMarks, count, context.avoidStems),
    temperature: GENERATION_TEMPERATURE,
    maxOutputTokens: 800 + count * 500,
  });
  return { items: validateGeneratedSection(data, typeMarks, count, context.avoidStems), model, promptVersion };
};

/**
 * The blind check: the objective items, WITHOUT their keys, answered by a
 * second call. A disagreement flags the item. A failed check (including the
 * cap) leaves items UNCHECKED rather than losing a section the teacher will
 * review anyway.
 */
export const checkAnswers = async (user, context, items, type) => {
  if (!isObjective(type) || !items.length) return items;
  try {
    const school = await getSchoolSettings().catch(() => null);
    const prompt = renderPrompt(QUESTION_CHECK_PROMPT, {
      schoolName: school?.name,
      context: {
        subjectName: context.subjectName,
        levelBand: context.levelBand,
        items: items.map((q, i) => ({ position: i + 1, type, stem: q.stem, options: q.options })),
      },
    });
    const { data } = await runJson({ feature: "PAPERS", user, prompt, schema: ANSWER_CHECK_SCHEMA, temperature: 0, maxOutputTokens: 200 + items.length * 40 });
    const byPosition = new Map((data.answers || []).map((a) => [Number(a.position), a.answer]));
    return items.map((q, i) => ({ ...q, check: compareAnswer(q, type, byPosition.get(i + 1)) }));
  } catch (error) {
    console.warn(`AI-3 answer check skipped: ${error?.message || error}`);
    return items.map((q) => ({ ...q, check: { status: "UNCHECKED" } }));
  }
};

const otherStems = async (paperId, exceptSection) => {
  const rows = await Question.findAll({ where: { paperId }, attributes: ["section", "stem"], raw: true });
  return (rows || []).filter((r) => Number(r.section) !== Number(exceptSection)).map((r) => r.stem);
};

const scopeFor = (user, paperId) => ({ createdBy: actorOf(user), feature: "PAPERS", entityType: PAPER_ENTITY, entityId: String(paperId) });

/** Generate section n of the teacher's own DRAFT paper as a draft for review. */
export const generateSection = async (user, paperId, n, { note } = {}) => {
  const teacherId = teacherIdOf(user);
  const paper = await loadOwnPaper(teacherId, paperId);
  assertDraft(paper);
  const { n: num, s } = sectionOf(paper, n);
  const context = await buildContext(paper, num, s, { avoidStems: await otherStems(paper.paperId, num), note });
  const typeMarks = { type: s.type, marksEach: s.marksEach };
  const generated = await callGeneration(user, context, typeMarks, s.count);
  const checked = await checkAnswers(user, context, generated.items, s.type);
  const items = checked.map((q) => ({ key: newKey(), ...q }));

  await sequelize.transaction(async (transaction) => {
    // The paper may have changed while the model was writing.
    const fresh = await loadOwnPaper(teacherId, paper.paperId, { transaction, lock: true });
    assertDraft(fresh);
    const now = sectionOf(fresh, num).s;
    if (now.type !== s.type) throw new AppError("This section changed while the AI was writing. Generate it again.", 409);
    const actor = actorOf(user);
    const stamp = new Date();
    await AiSuggestion.update(
      { status: "REJECTED", reviewedBy: actor, reviewedAt: stamp, updatedAt: stamp },
      { where: { feature: "PAPERS", entityType: PAPER_ENTITY, entityId: String(paper.paperId), field: sectionField(num), status: OPEN_DRAFT }, transaction }
    );
    await createSuggestion(
      {
        feature: "PAPERS",
        entityType: PAPER_ENTITY,
        entityId: String(paper.paperId),
        field: sectionField(num),
        content: { paperId: Number(paper.paperId), section: num, type: s.type, marksEach: s.marksEach, items },
        model: generated.model,
        promptVersion: generated.promptVersion,
        createdBy: actor,
      },
      { transaction }
    );
  });
  return getMyPaper(teacherId, paper.paperId);
};

const loadOpenDraft = async (user, paperId, suggestionId, opts = {}) => {
  const d = await getSuggestion(suggestionId, { scope: scopeFor(user, paperId), includePrivate: true, ...opts });
  if (!OPEN_DRAFT.includes(d.status)) throw new AppError(`This draft is already ${String(d.status).toLowerCase()}.`, 409);
  return d;
};

/** Regenerate one item (by its key) of an open draft. */
export const regenerateItem = async (user, paperId, suggestionId, { key, note } = {}) => {
  const teacherId = teacherIdOf(user);
  const paper = await loadOwnPaper(teacherId, paperId);
  assertDraft(paper);
  const draft = await loadOpenDraft(user, paper.paperId, suggestionId);
  const num = sectionOfField(draft.field);
  const { s } = sectionOf(paper, num);
  const items = draft.content?.items || [];
  const old = items.find((i) => i.key === key);
  if (!old) throw new AppError("That question is not in this draft any more. Reload and try again.", 404);

  const avoid = [...items.map((i) => i.stem), ...(await otherStems(paper.paperId, num))];
  const context = await buildContext(paper, num, s, { count: 1, avoidStems: avoid, note });
  const typeMarks = { type: draft.content.type, marksEach: round2(old.marks) };
  const generated = await callGeneration(user, context, typeMarks, 1);
  const [checked] = await checkAnswers(user, context, generated.items, draft.content.type);
  const fresh = { key: newKey(), ...checked, regenerated: true };

  await sequelize.transaction(async (transaction) => {
    const row = await loadOpenDraft(user, paper.paperId, suggestionId, { transaction, lock: true });
    const list = row.content?.items || [];
    const at = list.findIndex((i) => i.key === key);
    if (at === -1 || list[at].stem !== old.stem) {
      throw new AppError("That question changed while the AI was writing. Reload and try again.", 409);
    }
    const next = [...list];
    next[at] = fresh;
    await AiSuggestion.update(
      { content: { ...row.content, items: next }, updatedAt: new Date() },
      { where: { suggestionId: row.suggestionId }, transaction }
    );
  });
  return getMyPaper(teacherId, paper.paperId);
};

/**
 * The draft's items as the teacher left them: each must be one of the draft's
 * own items (by key), in any order, any deleted; all still valid. Changed items
 * are marked `edited`; a changed key clears the checker's flag.
 */
export const reviseDraftItems = (content, incoming) => {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new QuestionValidationError("A draft needs at least one question. To drop the whole section, discard the draft.");
  }
  const type = content.type;
  const byKey = new Map((content.items || []).map((i) => [i.key, i]));
  const seenKeys = new Set();
  const seenStems = new Set();
  return incoming.map((raw, index) => {
    const label = `Question ${index + 1}`;
    const prev = byKey.get(raw?.key);
    if (!prev || seenKeys.has(raw.key)) throw new QuestionValidationError(`${label} is not part of this draft. Reload and try again.`);
    seenKeys.add(raw.key);
    const marks = raw.marks === undefined ? prev.marks : raw.marks;
    const q = validateQuestion({ ...prev, ...raw }, type, marks, label);
    const k = normaliseStem(q.stem);
    if (seenStems.has(k)) throw new QuestionValidationError(`${label} repeats another question`);
    seenStems.add(k);
    const changed = contentChanged(prev, q);
    const check =
      changed && answerChanged(prev, q) ? { status: isObjective(type) ? "UNCHECKED" : "NOT_OBJECTIVE" } : prev.check || { status: "UNCHECKED" };
    return {
      key: prev.key,
      ...q,
      difficulty: q.difficulty ?? prev.difficulty ?? null,
      check,
      ...(prev.edited || changed ? { edited: true } : {}),
      ...(prev.regenerated ? { regenerated: true } : {}),
    };
  });
};

const ruled = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QuestionValidationError) throw new AppError(e.message, 400);
    throw e;
  }
};

export const saveDraft = async (user, paperId, suggestionId, items) => {
  const teacherId = teacherIdOf(user);
  const paper = await loadOwnPaper(teacherId, paperId);
  assertDraft(paper);
  const draft = await loadOpenDraft(user, paper.paperId, suggestionId);
  const next = ruled(() => reviseDraftItems(draft.content, items));
  await editSuggestion(draft.suggestionId, { ...draft.content, items: next }, { actor: actorOf(user), scope: scopeFor(user, paper.paperId), includePrivate: true });
  return getMyPaper(teacherId, paper.paperId);
};

export const discardDraft = async (user, paperId, suggestionId) => {
  const teacherId = teacherIdOf(user);
  const paper = await loadOwnPaper(teacherId, paperId);
  await rejectSuggestion(suggestionId, { actor: actorOf(user), scope: scopeFor(user, paper.paperId), includePrivate: true });
  return getMyPaper(teacherId, paper.paperId);
};

/** "Accept section": the waiting draft becomes its questions, or a hand-written section is marked checked. */
export const acceptSection = async (user, paperId, n) => {
  const teacherId = teacherIdOf(user);
  const paper = await loadOwnPaper(teacherId, paperId);
  assertDraft(paper);
  const { n: num } = sectionOf(paper, n);
  const drafts = await AiSuggestion.findAll({
    where: { ...scopeFor(user, paper.paperId), field: sectionField(num), status: OPEN_DRAFT },
    order: [["createdAt", "DESC"]],
    raw: true,
  });
  if (!drafts?.length) return markSectionAccepted(teacherId, paper.paperId, num);
  await acceptSuggestion(drafts[0].suggestionId, { actor: actorOf(user), scope: scopeFor(user, paper.paperId), includePrivate: true });
  return getMyPaper(teacherId, paper.paperId);
};

// ---------------------------------------------------------------- accept handler

const validateContentItems = (content) =>
  (content.items || []).map((item, i) => {
    const q = validateQuestion(item, content.type, item.marks, `Question ${i + 1}`);
    return { ...item, ...q };
  });

/**
 * Runs inside the transaction that marks the draft ACCEPTED (row locked).
 * Only the paper's own teacher can accept (an office user can't write into a
 * teacher's paper through /ai/suggestions). Replaces the section's questions.
 */
export const acceptPaperDraft = async (suggestion, { transaction, actor }) => {
  const c = suggestion.content || {};
  // The row's entityId / field say which paper and section the draft is for;
  // the content's copies must agree (they are pinned on edit as well).
  const paperId = /^\d{1,9}$/.test(String(suggestion.entityId ?? "")) ? Number(suggestion.entityId) : 0;
  const section = sectionOfField(suggestion.field);
  if (suggestion.entityType !== PAPER_ENTITY || !paperId || !section) {
    throw new AppError("This draft is not for a section of a question paper.", 400);
  }
  if (Number(c.paperId) !== paperId || Number(c.section) !== section) {
    throw new AppError("This draft doesn't match its paper and section. Discard it and generate again.", 409);
  }
  const paper = await QuestionPaper.findOne({
    where: { paperId },
    raw: true,
    transaction,
    ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!paper) throw new AppError("The question paper for this draft no longer exists.", 404);
  if (actor !== `STAFF:${paper.teacherId}`) throw new AppError("Only the teacher who owns this paper can accept its questions.", 403);
  if (paper.status !== "DRAFT") throw new AppError("This paper is final, so it can't be changed. Reopen it first.", 409);
  const spec = { ...specOf(paper), sections: [...specOf(paper).sections] };
  const s = spec.sections[section - 1];
  if (!s || s.type !== c.type) throw new AppError("This section has changed since the draft was written. Discard the draft and generate again.", 409);
  const items = ruled(() => validateContentItems(c));
  if (!items.length) throw new AppError("The draft has no questions.", 400);

  const now = new Date();
  await Question.destroy({ where: { paperId: paper.paperId, section }, transaction });
  await Question.bulkCreate(
    items.map((q, i) => ({
      paperId: paper.paperId,
      section,
      position: i + 1,
      type: c.type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      markingScheme: q.markingScheme,
      explanation: q.explanation,
      marks: q.marks,
      difficulty: q.difficulty ?? null,
      origin: q.edited ? "AI_EDITED" : "AI",
      checkerDisagrees: q.check?.status === "DISAGREE",
      checkerAnswer: q.check?.status === "DISAGREE" ? String(q.check.checkerAnswer ?? "").slice(0, 200) || null : null,
      promptVersion: suggestion.promptVersion || null,
      createdAt: now,
      updatedAt: now,
    })),
    { transaction }
  );
  spec.sections[section - 1] = { ...s, accepted: true };
  await QuestionPaper.update({ spec, updatedAt: now }, { where: { paperId: paper.paperId }, transaction });
  return { entityId: String(paper.paperId) };
};

/**
 * The draft's paper, section and question type are fixed when it is written:
 * the content must name the row's own paper (entityId) and section (field),
 * and an edit can't change the paper, section, type or marks each.
 */
export const pinnedProblem = (content, { previous, entityId, field } = {}) => {
  if (Number(content?.paperId) !== Number(entityId) || Number(content?.section) !== sectionOfField(field)) {
    return "The draft's paper and section can't be changed.";
  }
  if (previous) {
    for (const k of ["paperId", "section", "type", "marksEach"]) {
      if (String(content[k] ?? "") !== String(previous[k] ?? "")) return "The draft's paper, section and question type can't be changed.";
    }
  }
  return null;
};

// Paper drafts belong to the teacher: the office /ai/suggestions endpoints
// never list or touch them (the head teacher reads papers via /question-papers).
registerAcceptHandler("PAPERS", acceptPaperDraft, {
  officeReviewable: false,
  validateContent: (content, context) => {
    if (!Array.isArray(content?.items) || !content.items.length) return "The draft needs at least one question.";
    const pinned = pinnedProblem(content, context);
    if (pinned) return pinned;
    try {
      validateContentItems(content);
      return null;
    } catch (e) {
      return e instanceof QuestionValidationError ? e.message : "The draft is not valid.";
    }
  },
});
