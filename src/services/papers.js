// AI-3: question papers (ported from SchoolPro papers/papers.service.ts,
// reduced to one school). Everything here works with AI switched off: a
// teacher can always write a paper by hand. The AI parts (generate a section,
// regenerate one item, the checker pass, the section drafts) are in
// services/paperAi.js.
//
// Who may do what:
//   - a portal teacher (STAFF token) creates papers only for a class + subject
//     in their own scope this term (the same rule as scores, services/teacherScope.js),
//     not for KG / nursery classes (they have learning areas, not subjects);
//   - a teacher sees and changes only their own papers (anyone else's is a 404);
//   - a FINAL paper is read-only; only its teacher can reopen it (back to DRAFT);
//   - the Administrator (head teacher) can list and view every paper, read-only.
//
// Sections: spec.sections[i] is section i + 1. A section's questions are
// Question rows (section, position). An AI draft of a section waits in
// Ai_suggestion until the teacher accepts it (paperAi.js). "Accept section"
// marks the section checked; FINAL needs every section accepted, with at least
// one question and no AI draft still waiting.
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AiSuggestion, Class, Question, QuestionPaper, Subject, Teacher, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { paginatedResponse, parsePagination } from "../utils/pagination.js";
import { requireActiveTerm } from "./term.js";
import { canScore, isKgSection, loadTeacher } from "./teacherScope.js";
import {
  answerChanged,
  contentChanged,
  isObjective,
  normaliseSpec,
  paperTotalMarks,
  QuestionValidationError,
  round2,
  sectionMaxMarks,
  validateQuestion,
} from "./paperRules.js";

export const PAPER_ENTITY = "QUESTION_PAPER";
export const OPEN_DRAFT = ["PENDING", "EDITED"];
export const sectionField = (n) => `section:${n}`;
export const sectionOfField = (field) => {
  const m = /^section:(\d+)$/.exec(String(field || ""));
  return m ? Number(m[1]) : null;
};
export const sectionLetter = (n) => String.fromCharCode(64 + Number(n));

export const NOT_FOUND = "Question paper not found.";
export const FINAL_MESSAGE = "This paper is final, so it can't be changed. Reopen it first.";
export const SCOPE_MESSAGE =
  "You can only write papers for a class and subject you teach this term. Ask the school office if this should be yours.";
export const KG_MESSAGE = "Question papers are for primary and JHS subjects. KG and nursery classes use learning areas, not subjects.";

const toId = (v, what = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new AppError(`Invalid ${what}`, 400);
  return n;
};
const toSection = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new AppError("Section not found on this paper.", 404);
  return n;
};
const asRule = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof QuestionValidationError) throw new AppError(e.message, 400);
    throw e;
  }
};
const plain = (row) => (row && typeof row.get === "function" ? row.get({ plain: true }) : row);
const specOf = (paper) => {
  const s = paper.spec && typeof paper.spec === "object" ? paper.spec : {};
  return { topics: [], note: null, instructions: null, durationMinutes: null, ...s, sections: Array.isArray(s.sections) ? s.sections : [] };
};
export const termLabel = (t) => {
  if (!t) return "";
  const name = String(t.term ?? "").trim();
  return /^term/i.test(name) ? name : `Term ${name}`;
};

// ---------------------------------------------------------------- loading

/** The teacher's own paper (404 for anyone else's), optionally row-locked. */
export const loadOwnPaper = async (teacherId, paperId, { transaction, lock = false } = {}) => {
  const row = await QuestionPaper.findOne({
    where: { paperId: toId(paperId, "paper"), teacherId: Number(teacherId) },
    raw: true,
    ...(transaction ? { transaction } : {}),
    ...(lock && transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row) throw new AppError(NOT_FOUND, 404);
  return row;
};

export const assertDraft = (paper) => {
  if (paper.status !== "DRAFT") throw new AppError(FINAL_MESSAGE, 409);
};

const openDrafts = (paperIds, { transaction } = {}) =>
  AiSuggestion.findAll({
    where: { feature: "PAPERS", entityType: PAPER_ENTITY, entityId: paperIds.map(String), status: OPEN_DRAFT },
    order: [["createdAt", "DESC"]],
    raw: true,
    ...(transaction ? { transaction } : {}),
  });

const questionsOf = (paperId, { transaction } = {}) =>
  Question.findAll({
    where: { paperId },
    order: [["section", "ASC"], ["position", "ASC"]],
    raw: true,
    ...(transaction ? { transaction } : {}),
  });

const namesFor = async (papers) => {
  const ids = (k) => [...new Set(papers.map((p) => p[k]).filter((v) => v != null))];
  const [teachers, subjects, classes, terms] = await Promise.all([
    Teacher.findAll({ where: { teacherId: ids("teacherId") }, attributes: ["teacherId", "fName", "lName"], raw: true }),
    Subject.findAll({ where: { subjectId: ids("subjectId") }, attributes: ["subjectId", "name"], raw: true }),
    Class.findAll({ where: { classId: ids("classId") }, attributes: ["classId", "name", "section"], raw: true }),
    Term.findAll({ where: { termId: ids("termId") }, attributes: ["termId", "term"], raw: true }),
  ]);
  const by = (rows, k) => new Map((rows || []).map((r) => [Number(r[k]), r]));
  return { teachers: by(teachers, "teacherId"), subjects: by(subjects, "subjectId"), classes: by(classes, "classId"), terms: by(terms, "termId") };
};

const refs = (p, names) => {
  const t = names.teachers.get(Number(p.teacherId));
  const s = names.subjects.get(Number(p.subjectId));
  const c = names.classes.get(Number(p.classId));
  const term = names.terms.get(Number(p.termId));
  return {
    teacher: { teacherId: Number(p.teacherId), name: t ? [t.fName, t.lName].filter(Boolean).join(" ") : "" },
    subject: { subjectId: Number(p.subjectId), name: s?.name || "" },
    class: { classId: Number(p.classId), name: c?.name || "", section: c?.section || null },
    term: { termId: Number(p.termId), name: termLabel(term) },
  };
};

export const questionView = (q, number) => ({
  questionId: Number(q.questionId),
  section: Number(q.section),
  position: Number(q.position),
  number,
  type: q.type,
  stem: q.stem,
  options: q.options ?? null,
  answer: q.answer ?? null,
  markingScheme: Array.isArray(q.markingScheme) ? q.markingScheme : [],
  explanation: q.explanation ?? null,
  marks: round2(q.marks),
  difficulty: q.difficulty ?? null,
  origin: q.origin,
  checkerDisagrees: Boolean(q.checkerDisagrees),
  checkerAnswer: q.checkerAnswer ?? null,
});

const draftView = (d) =>
  d
    ? {
        suggestionId: Number(d.suggestionId),
        status: d.status,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        items: Array.isArray(d.content?.items) ? d.content.items : [],
        flaggedCount: (d.content?.items || []).filter((i) => i.check?.status === "DISAGREE").length,
      }
    : null;

/** Why the paper can't be marked FINAL yet (empty = it can). */
export const finaliseBlockers = (spec, bySection, draftsBySection) => {
  const out = [];
  const total = Object.values(bySection).reduce((t, list) => t + list.length, 0);
  if (!total) out.push("Add at least one question.");
  spec.sections.forEach((s, i) => {
    const n = i + 1;
    const name = s.title || `Section ${sectionLetter(n)}`;
    if (draftsBySection[n]) out.push(`${name} has an AI draft waiting. Accept it or discard it.`);
    else if (!(bySection[n] || []).length) out.push(`${name} has no questions. Add some, or remove the section.`);
    else if (!s.accepted) out.push(`Accept ${name} once you have checked it.`);
  });
  return out;
};

/** The full paper: sections with their questions (numbered across the paper) and any AI draft. */
export const buildPaperView = async (paper, { withDrafts = true, transaction } = {}) => {
  const p = plain(paper);
  const spec = specOf(p);
  const [questions, drafts, names] = await Promise.all([
    questionsOf(p.paperId, { transaction }),
    withDrafts ? openDrafts([p.paperId], { transaction }) : [],
    namesFor([p]),
  ]);
  const bySection = {};
  for (const q of questions || []) (bySection[q.section] ||= []).push(q);
  const draftsBySection = {};
  for (const d of drafts || []) {
    const n = sectionOfField(d.field);
    if (n && !draftsBySection[n]) draftsBySection[n] = d; // newest first
  }
  let number = 0;
  const sections = spec.sections.map((s, i) => {
    const n = i + 1;
    const list = (bySection[n] || []).map((q) => questionView(q, (number += 1)));
    return {
      number: n,
      letter: sectionLetter(n),
      ...s,
      accepted: Boolean(s.accepted),
      questions: list,
      totalMarks: sectionMaxMarks(s, list),
      draft: draftView(draftsBySection[n]),
    };
  });
  const blockers = finaliseBlockers(spec, bySection, draftsBySection);
  return {
    paperId: Number(p.paperId),
    title: p.title,
    status: p.status,
    ...refs(p, names),
    topics: spec.topics,
    note: spec.note,
    instructions: spec.instructions,
    durationMinutes: spec.durationMinutes,
    sections,
    questionCount: number,
    totalMarks: paperTotalMarks(spec.sections, bySection),
    flaggedCount: (questions || []).filter((q) => q.checkerDisagrees).length,
    canFinalise: p.status === "DRAFT" && blockers.length === 0,
    finaliseBlockers: p.status === "DRAFT" ? blockers : [],
    finalisedAt: p.finalisedAt ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
};

/** Short rows for a list (no question text). */
const summaries = async (papers) => {
  if (!papers.length) return [];
  const ids = papers.map((p) => p.paperId);
  const [questions, drafts, names] = await Promise.all([
    Question.findAll({ where: { paperId: ids }, attributes: ["paperId", "section", "marks"], raw: true }),
    openDrafts(ids),
    namesFor(papers),
  ]);
  return papers.map((p) => {
    const spec = specOf(p);
    const mine = (questions || []).filter((q) => Number(q.paperId) === Number(p.paperId));
    const bySection = {};
    for (const q of mine) (bySection[q.section] ||= []).push(q);
    return {
      paperId: Number(p.paperId),
      title: p.title,
      status: p.status,
      ...refs(p, names),
      sectionCount: spec.sections.length,
      questionCount: mine.length,
      totalMarks: paperTotalMarks(spec.sections, bySection),
      draftsWaiting: (drafts || []).filter((d) => String(d.entityId) === String(p.paperId)).length,
      updatedAt: p.updatedAt,
      finalisedAt: p.finalisedAt ?? null,
    };
  });
};

// ---------------------------------------------------------------- teacher: papers

export const listMyPapers = async (teacherId, query = {}) => {
  const where = { teacherId: Number(teacherId) };
  if (query.status && ["DRAFT", "FINAL"].includes(String(query.status).toUpperCase())) where.status = String(query.status).toUpperCase();
  if (query.termId) where.termId = toId(query.termId, "term");
  const rows = await QuestionPaper.findAll({ where, order: [["updatedAt", "DESC"], ["paperId", "DESC"]], limit: 200, raw: true });
  return { papers: await summaries(rows || []) };
};

export const getMyPaper = async (teacherId, paperId) => buildPaperView(await loadOwnPaper(teacherId, paperId));

/** A new paper, this term, for a class + subject in the teacher's scope. */
export const createPaper = async (teacherId, body = {}) => {
  const teacher = await loadTeacher(teacherId);
  const term = await requireActiveTerm();
  const classId = toId(body.classId, "class");
  const subjectId = toId(body.subjectId, "subject");
  const [klass, subject] = await Promise.all([
    Class.findOne({ where: { classId, isDeleted: false }, attributes: ["classId", "name", "section"], raw: true }),
    Subject.findOne({ where: { subjectId, isDeleted: false }, attributes: ["subjectId", "name"], raw: true }),
  ]);
  if (!klass) throw new AppError("Class not found", 404);
  if (!subject) throw new AppError("Subject not found", 404);
  if (isKgSection(klass.section)) throw new AppError(KG_MESSAGE, 400);
  if (!(await canScore(teacher.teacherId, { termId: term.termId, classId, subjectId }))) throw new AppError(SCOPE_MESSAGE, 403);

  const spec = asRule(() => normaliseSpec(body));
  const title = String(body.title || "").trim().slice(0, 150) || `${subject.name}: ${klass.name}`;
  const now = new Date();
  const row = await QuestionPaper.create({
    teacherId: teacher.teacherId,
    subjectId,
    classId,
    termId: term.termId,
    title,
    spec,
    status: "DRAFT",
    createdAt: now,
    updatedAt: now,
  });
  return buildPaperView(row);
};

/** Run fn(paper, transaction) with the teacher's own DRAFT paper locked, then return the fresh view. */
export const withOwnDraft = (teacherId, paperId, fn) =>
  sequelize
    .transaction(async (transaction) => {
      const paper = await loadOwnPaper(teacherId, paperId, { transaction, lock: true });
      assertDraft(paper);
      await fn(paper, transaction);
      return paper.paperId;
    })
    .then((id) => getMyPaper(teacherId, id));

const touch = (paperId, transaction, extra = {}) =>
  QuestionPaper.update({ ...extra, updatedAt: new Date() }, { where: { paperId }, transaction });

/**
 * Title, topics, note, instructions, duration and the sections. Sections can be
 * added at the end or changed in place; a section's type can't change while it
 * has questions or a waiting draft. Removing a section is DELETE .../sections/:n.
 */
export const updatePaper = (teacherId, paperId, body = {}) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const prev = specOf(paper);
    if (Array.isArray(body.sections) && body.sections.length < prev.sections.length) {
      throw new AppError("To remove a section, use Remove section on it.", 400);
    }
    const spec = asRule(() => normaliseSpec(body, prev));
    const changedType = spec.sections
      .map((s, i) => (prev.sections[i] && prev.sections[i].type !== s.type ? i + 1 : null))
      .filter(Boolean);
    if (changedType.length) {
      const [count, drafts] = await Promise.all([
        Question.count({ where: { paperId: paper.paperId, section: changedType }, transaction }),
        openDrafts([paper.paperId], { transaction }),
      ]);
      const draftThere = (drafts || []).some((d) => changedType.includes(sectionOfField(d.field)));
      if (count || draftThere) {
        throw new AppError(`Section ${sectionLetter(changedType[0])} already has questions. Delete them (or discard its draft) before changing its type.`, 409);
      }
    }
    const title = body.title !== undefined ? String(body.title || "").trim().slice(0, 150) : paper.title;
    if (!title) throw new AppError("The paper needs a title.", 400);
    await touch(paper.paperId, transaction, { title, spec });
  });

/** Remove section n with its questions (and any waiting draft); later sections move up. */
export const removeSection = (teacherId, paperId, n, { actor } = {}) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const section = toSection(n);
    const spec = specOf(paper);
    if (!spec.sections[section - 1]) throw new AppError("Section not found on this paper.", 404);
    if (spec.sections.length === 1) throw new AppError("A paper needs at least one section.", 400);
    await Question.destroy({ where: { paperId: paper.paperId, section }, transaction });
    await Question.update(
      { section: sequelize.literal("section - 1") },
      { where: { paperId: paper.paperId, section: { [Op.gt]: section } }, transaction }
    );
    const now = new Date();
    for (const d of (await openDrafts([paper.paperId], { transaction })) || []) {
      const at = sectionOfField(d.field);
      if (at === section) {
        // eslint-disable-next-line no-await-in-loop
        await AiSuggestion.update(
          { status: "REJECTED", reviewedBy: actor || null, reviewedAt: now, updatedAt: now },
          { where: { suggestionId: d.suggestionId }, transaction }
        );
      } else if (at > section) {
        // eslint-disable-next-line no-await-in-loop
        await AiSuggestion.update(
          { field: sectionField(at - 1), content: { ...d.content, section: at - 1 }, updatedAt: now },
          { where: { suggestionId: d.suggestionId }, transaction }
        );
      }
    }
    spec.sections.splice(section - 1, 1);
    await touch(paper.paperId, transaction, { spec });
  });

/** A DRAFT paper, its questions and waiting drafts (a FINAL one must be reopened first). */
export const deletePaper = async (teacherId, paperId, { actor } = {}) => {
  await sequelize.transaction(async (transaction) => {
    const paper = await loadOwnPaper(teacherId, paperId, { transaction, lock: true });
    assertDraft(paper);
    const now = new Date();
    await AiSuggestion.update(
      { status: "REJECTED", reviewedBy: actor || null, reviewedAt: now, updatedAt: now },
      { where: { feature: "PAPERS", entityType: PAPER_ENTITY, entityId: String(paper.paperId), status: OPEN_DRAFT }, transaction }
    );
    await Question.destroy({ where: { paperId: paper.paperId }, transaction });
    await QuestionPaper.destroy({ where: { paperId: paper.paperId }, transaction });
  });
  return { deleted: true };
};

/** DRAFT -> FINAL (when nothing blocks it) or FINAL -> DRAFT (reopen). Owner only. */
export const setPaperStatus = async (teacherId, paperId, status) => {
  const want = String(status || "").toUpperCase();
  if (!["DRAFT", "FINAL"].includes(want)) throw new AppError("Status must be DRAFT or FINAL.", 400);
  await sequelize.transaction(async (transaction) => {
    const paper = await loadOwnPaper(teacherId, paperId, { transaction, lock: true });
    if (paper.status === want) return;
    if (want === "FINAL") {
      const view = await buildPaperView(paper, { transaction });
      if (view.finaliseBlockers.length) {
        throw new AppError(`This paper isn't ready to mark final: ${view.finaliseBlockers[0]}`, 409);
      }
      await touch(paper.paperId, transaction, { status: "FINAL", finalisedAt: new Date() });
    } else {
      await touch(paper.paperId, transaction, { status: "DRAFT", finalisedAt: null });
    }
  });
  return getMyPaper(teacherId, paperId);
};

// ---------------------------------------------------------------- teacher: questions by hand

const sectionSpec = (paper, n) => {
  const s = specOf(paper).sections[n - 1];
  if (!s) throw new AppError("Section not found on this paper.", 404);
  return s;
};

const loadQuestion = async (paper, questionId, transaction) => {
  const q = await Question.findOne({ where: { questionId: toId(questionId, "question"), paperId: paper.paperId }, raw: true, transaction });
  if (!q) throw new AppError("Question not found on this paper.", 404);
  return q;
};

const checkStemUnique = async (paper, stem, transaction, exceptId = null) => {
  const all = await Question.findAll({ where: { paperId: paper.paperId }, attributes: ["questionId", "stem"], raw: true, transaction });
  const key = stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if ((all || []).some((q) => Number(q.questionId) !== Number(exceptId) && q.stem.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === key)) {
    throw new AppError("This question is already on the paper.", 409);
  }
};

/** A question written by hand (origin TEACHER), at the end of its section. */
export const addQuestion = (teacherId, paperId, n, body = {}) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const section = toSection(n);
    const spec = sectionSpec(paper, section);
    const marks = body.marks === undefined || body.marks === "" ? spec.marksEach : body.marks;
    const q = asRule(() => validateQuestion(body, spec.type, marks, "This question"));
    await checkStemUnique(paper, q.stem, transaction);
    const max = await Question.max("position", { where: { paperId: paper.paperId, section }, transaction });
    if ((Number(max) || 0) >= 60) throw new AppError("A section can have at most 60 questions.", 400);
    const now = new Date();
    await Question.create(
      {
        paperId: paper.paperId,
        section,
        position: (Number(max) || 0) + 1,
        type: spec.type,
        ...q,
        origin: "TEACHER",
        checkerDisagrees: false,
        checkerAnswer: null,
        createdAt: now,
        updatedAt: now,
      },
      { transaction }
    );
    await touch(paper.paperId, transaction);
  });

/** Edit one question. An AI question becomes AI_EDITED; a new key clears the checker's flag. */
export const updateQuestion = (teacherId, paperId, questionId, body = {}) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const before = await loadQuestion(paper, questionId, transaction);
    const merged = {
      stem: body.stem ?? before.stem,
      options: body.options !== undefined ? body.options : before.options,
      answer: body.answer !== undefined ? body.answer : before.answer,
      markingScheme: body.markingScheme !== undefined ? body.markingScheme : before.markingScheme,
      explanation: body.explanation !== undefined ? body.explanation : before.explanation,
      difficulty: body.difficulty !== undefined ? body.difficulty : before.difficulty,
    };
    const marks = body.marks !== undefined ? body.marks : before.marks;
    const q = asRule(() => validateQuestion(merged, before.type, marks, "This question"));
    const prev = { ...before, marks: round2(before.marks) };
    if (!contentChanged(prev, q) && (q.difficulty ?? null) === (before.difficulty ?? null)) return; // nothing to save
    if (q.stem !== before.stem) await checkStemUnique(paper, q.stem, transaction, before.questionId);
    const clearCheck = answerChanged(prev, q) || q.stem !== before.stem;
    await Question.update(
      {
        ...q,
        origin: before.origin === "TEACHER" ? "TEACHER" : "AI_EDITED",
        ...(clearCheck ? { checkerDisagrees: false, checkerAnswer: null } : {}),
        updatedAt: new Date(),
      },
      { where: { questionId: before.questionId }, transaction }
    );
    await touch(paper.paperId, transaction);
  });

/** Delete one question; the rest of its section closes up. */
export const deleteQuestion = (teacherId, paperId, questionId) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const q = await loadQuestion(paper, questionId, transaction);
    await Question.destroy({ where: { questionId: q.questionId }, transaction });
    await Question.update(
      { position: sequelize.literal("position - 1") },
      { where: { paperId: paper.paperId, section: q.section, position: { [Op.gt]: q.position } }, transaction }
    );
    await touch(paper.paperId, transaction);
  });

/** New order of one section: `questionIds` must be exactly that section's questions. */
export const reorderSection = (teacherId, paperId, n, questionIds) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const section = toSection(n);
    sectionSpec(paper, section);
    const rows = await Question.findAll({ where: { paperId: paper.paperId, section }, attributes: ["questionId", "position"], raw: true, transaction });
    const ids = Array.isArray(questionIds) ? questionIds.map(Number) : [];
    const have = new Set((rows || []).map((r) => Number(r.questionId)));
    if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id))) {
      throw new AppError("The order must list every question in the section exactly once. Reload and try again.", 409);
    }
    // The (paper, section, position) key is checked at commit (DEFERRABLE), so swaps are fine.
    for (let i = 0; i < ids.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Question.update({ position: i + 1 }, { where: { questionId: ids[i] }, transaction });
    }
    await touch(paper.paperId, transaction);
  });

/** A hand-written section the teacher has checked (a section with an AI draft goes through paperAi.acceptSection). */
export const markSectionAccepted = (teacherId, paperId, n) =>
  withOwnDraft(teacherId, paperId, async (paper, transaction) => {
    const section = toSection(n);
    sectionSpec(paper, section);
    const count = await Question.count({ where: { paperId: paper.paperId, section }, transaction });
    if (!count) throw new AppError("Add questions to this section before accepting it.", 400);
    const spec = specOf(paper);
    spec.sections[section - 1] = { ...spec.sections[section - 1], accepted: true };
    await touch(paper.paperId, transaction, { spec });
  });

// ---------------------------------------------------------------- office: the head teacher's view

/** Every paper (Administrator, read-only). Filters: termId, classId, subjectId, teacherId, status; page/limit. */
export const listAllPapers = async (query = {}) => {
  const where = {};
  for (const k of ["termId", "classId", "subjectId", "teacherId"]) if (query[k]) where[k] = toId(query[k], k);
  if (query.status && ["DRAFT", "FINAL"].includes(String(query.status).toUpperCase())) where.status = String(query.status).toUpperCase();
  const options = { where, order: [["updatedAt", "DESC"], ["paperId", "DESC"]], raw: true };
  const paging = parsePagination(query, { maxLimit: 100 });
  if (paging) {
    const result = await QuestionPaper.findAndCountAll({ ...options, limit: paging.limit, offset: paging.offset });
    return paginatedResponse("papers", { rows: await summaries(result.rows || []), count: result.count }, paging);
  }
  return { papers: await summaries((await QuestionPaper.findAll({ ...options, limit: 200 })) || []) };
};

export const getAnyPaper = async (paperId) => {
  const row = await QuestionPaper.findOne({ where: { paperId: toId(paperId, "paper") }, raw: true });
  if (!row) throw new AppError(NOT_FOUND, 404);
  return buildPaperView(row, { withDrafts: false });
};

export { isObjective };
