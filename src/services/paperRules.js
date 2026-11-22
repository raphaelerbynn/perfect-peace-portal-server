// AI-3: question papers, the pure rules (no models, no AI). Ported from
// SchoolPro's papers.types.ts and question-set.validation.ts. The service,
// the AI generator and the accept handler all use these, so a rule is stated
// once. The portal keeps a copy of the totals helpers (src/Pages/Teacher/papers.js).

export const QUESTION_TYPES = Object.freeze(["MCQ", "TRUE_FALSE", "FILL_IN", "SHORT_ANSWER", "ESSAY", "STRUCTURED"]);
/** One checkable right answer: the blind checker pass answers these. */
export const OBJECTIVE_TYPES = Object.freeze(["MCQ", "TRUE_FALSE", "FILL_IN"]);
export const DIFFICULTIES = Object.freeze(["EASY", "MEDIUM", "HARD"]);
export const SECTION_DIFFICULTIES = Object.freeze(["EASY", "MEDIUM", "HARD", "MIXED"]);
export const ORIGINS = Object.freeze(["AI", "AI_EDITED", "TEACHER"]);
export const PAPER_STATUSES = Object.freeze(["DRAFT", "FINAL"]);

export const TYPE_LABELS = Object.freeze({
  MCQ: "Multiple choice",
  TRUE_FALSE: "True or false",
  FILL_IN: "Fill in the blank",
  SHORT_ANSWER: "Short answer",
  ESSAY: "Essay",
  STRUCTURED: "Structured",
});

/** One section is one model call. */
export const MAX_ITEMS_PER_SECTION = 20;
export const MAX_SECTIONS = 6;
export const MAX_MARKS_PER_ITEM = 50;
export const MAX_TOPICS = 8;

export const LEVEL_BANDS = Object.freeze(["KG", "B1-B3", "B4-B6", "JHS"]);

export class QuestionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

const MCQ_KEYS = ["A", "B", "C", "D"];
const TF_KEYS = ["TRUE", "FALSE"];

const clean = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
export const round2 = (n) => Math.round(Number(n) * 100) / 100;
const fail = (message) => {
  throw new QuestionValidationError(message);
};

export const normaliseStem = (stem) =>
  String(stem || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const normaliseAnswerText = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.]$/, "")
    .trim();

export const isObjective = (type) => OBJECTIVE_TYPES.includes(type);

/**
 * One question of a known type and mark value, checked and normalised.
 *   strictKeys     model output: MCQ options must come keyed A, B, C, D in order
 *   requireScheme  model output: written questions need a marking scheme
 *   requireDifficulty  model output: EASY | MEDIUM | HARD
 * Objective items get a one-line marking scheme from their key.
 */
export function validateQuestion(raw, type, marks, label = "This question", opts = {}) {
  const { strictKeys = false, requireScheme = false, requireDifficulty = false } = opts;
  if (!QUESTION_TYPES.includes(type)) fail(`${label} has an unknown question type`);
  const item = raw && typeof raw === "object" ? raw : {};
  const stem = clean(item.stem);
  if (!stem) fail(`${label} has no question text`);
  if (stem.length < 3) fail(`${label}'s question text is too short`);
  if (stem.length > 2000) fail(`${label} is too long (${stem.length} characters, at most 2000)`);
  const m = Number(marks);
  if (!Number.isFinite(m) || m <= 0 || m > MAX_MARKS_PER_ITEM) fail(`${label} needs marks between 0 and ${MAX_MARKS_PER_ITEM}`);
  const mk = round2(m);

  let difficulty = clean(item.difficulty).toUpperCase() || null;
  if (difficulty && !DIFFICULTIES.includes(difficulty)) {
    if (requireDifficulty) fail(`${label} has an unknown difficulty "${difficulty}"`);
    difficulty = null;
  }
  if (requireDifficulty && !difficulty) fail(`${label} has no difficulty`);

  let options = null;
  let answer = null;
  const rawAnswer = item.answer && typeof item.answer === "object" ? item.answer : null;

  if (type === "MCQ") {
    const list = Array.isArray(item.options) ? item.options : [];
    if (list.length !== 4) fail(`${label} has ${list.length} options; a multiple-choice question needs exactly 4 (A to D)`);
    if (strictKeys) {
      const given = list.map((o) => clean(o && o.key).toUpperCase());
      if (given.some((k, i) => k !== MCQ_KEYS[i])) fail(`${label}'s options must be keyed A, B, C and D in order`);
    }
    options = list.map((o, i) => ({ key: MCQ_KEYS[i], text: clean(o && typeof o === "object" ? o.text : o) }));
    if (options.some((o) => !o.text)) fail(`${label} has an empty option`);
    if (options.some((o) => o.text.length > 400)) fail(`${label} has an option that is too long`);
    if (new Set(options.map((o) => normaliseAnswerText(o.text))).size !== 4) fail(`${label} has two options that are the same`);
    const key = clean(rawAnswer && rawAnswer.key).toUpperCase();
    if (!MCQ_KEYS.includes(key)) fail(`${label}'s answer must be one of the options (A, B, C or D)`);
    answer = { key };
  } else if (type === "TRUE_FALSE") {
    const key = clean(rawAnswer && rawAnswer.key).toUpperCase();
    if (!TF_KEYS.includes(key)) fail(`${label} needs an answer of TRUE or FALSE`);
    answer = { key };
  } else if (type === "FILL_IN" || type === "SHORT_ANSWER") {
    const accepted = (Array.isArray(rawAnswer && rawAnswer.accepted) ? rawAnswer.accepted : [])
      .map(clean)
      .filter(Boolean)
      .map((a) => a.slice(0, 200));
    if (accepted.length === 0) fail(`${label} has no accepted answer`);
    answer = { accepted: [...new Set(accepted)].slice(0, 10) };
  }

  let markingScheme = (Array.isArray(item.markingScheme) ? item.markingScheme : [])
    .map((e) => ({ point: clean(e && e.point).slice(0, 500), marks: Number(e && e.marks) }))
    .filter((e) => e.point);

  if (isObjective(type)) {
    const expected = type === "FILL_IN" ? answer.accepted.join(" / ") : answer.key;
    markingScheme = [{ point: `Correct answer: ${expected}`, marks: mk }];
  } else if (markingScheme.length === 0) {
    if (requireScheme) fail(`${label} has no marking scheme`);
  } else {
    if (markingScheme.some((e) => !Number.isFinite(e.marks) || e.marks < 0)) fail(`${label} has a marking point without a mark`);
    markingScheme = markingScheme.map((e) => ({ point: e.point, marks: round2(e.marks) }));
    const sum = round2(markingScheme.reduce((t, e) => t + e.marks, 0));
    if (sum !== mk) fail(`${label}'s marking scheme adds up to ${sum}, not ${mk}`);
  }

  const explanation = clean(item.explanation).slice(0, 1000) || null;
  return { stem, options, answer, markingScheme, explanation, difficulty, marks: mk };
}

const VALIDATE_MODEL = { strictKeys: true, requireScheme: true, requireDifficulty: true };

/**
 * A whole generated section: exactly the count asked for, each item at the
 * section's marks, no repeated stems and none repeating `avoidStems`.
 */
export function validateGeneratedSection(data, { type, marksEach }, expectedCount, avoidStems = []) {
  const items = data && Array.isArray(data.items) ? data.items : null;
  if (!items) fail("the response had no items array");
  if (items.length !== expectedCount) fail(`expected ${expectedCount} questions, got ${items.length}`);
  const seen = new Set(avoidStems.map(normaliseStem));
  return items.map((raw, i) => {
    const label = `Question ${i + 1}`;
    const q = validateQuestion(raw, type, marksEach, label, VALIDATE_MODEL);
    const k = normaliseStem(q.stem);
    if (seen.has(k)) fail(`${label} repeats another question`);
    seen.add(k);
    return { ...q, check: { status: isObjective(type) ? "UNCHECKED" : "NOT_OBJECTIVE" } };
  });
}

/** For runJson's `validate`: the problem as text, or null. */
export const sectionProblem = (data, spec, count, avoidStems) => {
  try {
    validateGeneratedSection(data, spec, count, avoidStems);
    return null;
  } catch (e) {
    if (e instanceof QuestionValidationError) return e.message;
    throw e;
  }
};

/** Does the checker's own answer agree with the key? */
export function compareAnswer(item, type, checkerAnswer) {
  if (!isObjective(type)) return { status: "NOT_OBJECTIVE" };
  const given = clean(checkerAnswer);
  if (!given) return { status: "UNCHECKED" };
  if (type === "MCQ" || type === "TRUE_FALSE") {
    const letters = given.toUpperCase().replace(/[^A-Z]/g, "");
    const normalised = type === "MCQ" ? letters.slice(0, 1) : letters;
    const key = String((item.answer && item.answer.key) || "").toUpperCase();
    return { status: normalised === key ? "AGREE" : "DISAGREE", checkerAnswer: (normalised || given).slice(0, 200) };
  }
  const accepted = ((item.answer && item.answer.accepted) || []).map(normaliseAnswerText);
  return { status: accepted.includes(normaliseAnswerText(given)) ? "AGREE" : "DISAGREE", checkerAnswer: given.slice(0, 200) };
}

/** Did an edit change what the answer is (stem, options or key)? Then an old checker flag no longer applies. */
export const answerChanged = (before, after) =>
  JSON.stringify(before.answer ?? null) !== JSON.stringify(after.answer ?? null) ||
  JSON.stringify(before.options ?? null) !== JSON.stringify(after.options ?? null);

/** Did the teacher change anything a pupil or marker would see? */
export const contentChanged = (before, after) =>
  before.stem !== after.stem ||
  answerChanged(before, after) ||
  JSON.stringify(before.markingScheme ?? []) !== JSON.stringify(after.markingScheme ?? []) ||
  (before.explanation ?? null) !== (after.explanation ?? null) ||
  round2(before.marks) !== round2(after.marks);

// ---------------------------------------------------------------- spec

const intIn = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new QuestionValidationError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};

/** One section as stored in spec.sections. `prev` keeps the accepted flag. */
export function normaliseSection(raw, index, prev = null) {
  const s = raw && typeof raw === "object" ? raw : {};
  const label = `Section ${index + 1}`;
  const type = clean(s.type).toUpperCase();
  if (!QUESTION_TYPES.includes(type)) fail(`${label} needs a question type`);
  const count = intIn(s.count, 1, MAX_ITEMS_PER_SECTION, `${label}: number of questions`);
  const marksEach = Number(s.marksEach);
  if (!Number.isFinite(marksEach) || marksEach <= 0 || marksEach > MAX_MARKS_PER_ITEM) {
    fail(`${label}: marks for each question must be more than 0 and at most ${MAX_MARKS_PER_ITEM}`);
  }
  const difficulty = clean(s.difficulty).toUpperCase() || "MIXED";
  if (!SECTION_DIFFICULTIES.includes(difficulty)) fail(`${label} has an unknown difficulty`);
  let answerAny = s.answerAny === undefined || s.answerAny === null || s.answerAny === "" ? null : intIn(s.answerAny, 1, count, `${label}: "answer any"`);
  if (answerAny === count) answerAny = null;
  const title = clean(s.title).slice(0, 120) || `Section ${String.fromCharCode(65 + index)}`;
  return {
    title,
    type,
    count,
    marksEach: round2(marksEach),
    difficulty,
    answerAny,
    accepted: prev && prev.type === type ? Boolean(prev.accepted) : false,
  };
}

/** The whole spec from a create/update body. `prev` = the stored spec (update). */
export function normaliseSpec(body = {}, prev = null) {
  const base = prev || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const topics = has("topics")
    ? (Array.isArray(body.topics) ? body.topics : String(body.topics || "").split(/[\n,;]/))
        .map(clean)
        .filter(Boolean)
        .map((t) => t.slice(0, 120))
    : base.topics || [];
  if (topics.length > MAX_TOPICS) fail(`At most ${MAX_TOPICS} topics`);
  const note = has("note") ? clean(body.note).slice(0, 500) || null : base.note ?? null;
  const instructions = has("instructions") ? clean(body.instructions).slice(0, 500) || null : base.instructions ?? null;
  let durationMinutes = base.durationMinutes ?? null;
  if (has("durationMinutes")) {
    durationMinutes = body.durationMinutes === null || body.durationMinutes === "" ? null : intIn(body.durationMinutes, 5, 300, "Duration (minutes)");
  }
  let sections = base.sections || [];
  if (has("sections")) {
    if (!Array.isArray(body.sections) || body.sections.length === 0) fail("A paper needs at least one section");
    if (body.sections.length > MAX_SECTIONS) fail(`At most ${MAX_SECTIONS} sections`);
    sections = body.sections.map((s, i) => normaliseSection(s, i, (base.sections || [])[i]));
  }
  if (!sections.length) fail("A paper needs at least one section");
  return { topics: [...new Set(topics)], note, instructions, durationMinutes, sections };
}

// ---------------------------------------------------------------- totals

/** Marks a pupil can score in a section: "answer any N" counts the N best-marked questions. */
export function sectionMaxMarks(section, questions) {
  const marks = (questions || []).map((q) => round2(q.marks)).sort((a, b) => b - a);
  const counted = section && section.answerAny ? marks.slice(0, section.answerAny) : marks;
  return round2(counted.reduce((t, m) => t + m, 0));
}

export const paperTotalMarks = (sections, questionsBySection) =>
  round2(sections.reduce((t, s, i) => t + sectionMaxMarks(s, questionsBySection[i + 1] || []), 0));

// ---------------------------------------------------------------- level band

/**
 * The class's reading band, from its name first ("Basic 5", "Class 2", "JHS 1",
 * "KG 2") and its section when the name says nothing. Ported from SchoolPro.
 */
export function levelBandFor(className, section) {
  const name = String(className || "").trim().toLowerCase();
  if (/\b(kg|kindergarten|nursery|nursury|creche|crèche|pre-?school)\b/.test(name)) return "KG";
  if (/\bjhs\b|junior high|\bform\s*[1-3]\b/.test(name)) return "JHS";
  const numbered = /\b(?:basic|class|primary|grade|year|stage|p|b)\s*(\d{1,2})\b/.exec(name);
  if (numbered) {
    const n = Number(numbered[1]);
    if (n <= 3) return "B1-B3";
    if (n <= 6) return "B4-B6";
    return "JHS";
  }
  const sec = String(section || "").toLowerCase();
  if (/kg|nursery|nursury|creche/.test(sec)) return "KG";
  if (/jhs|junior/.test(sec)) return "JHS";
  if (/lower/.test(sec)) return "B1-B3";
  return "B4-B6";
}
