// AI-3: one question paper section, and the blind answer check. Ported from
// SchoolPro's prompts/question-set.prompt.ts. No pupil data reaches either
// prompt: subject, class, level band, topics, the section spec and the
// teacher's own note (run.js scrubs contact data from it).
import { registerPrompt } from "./registry.js";

const BANDS = [
  "Level bands, and how to write for each:",
  "- KG: very short sentences of up to 10 words, everyday objects, counting to 20, pictures described in words.",
  "- B1-B3 (lower primary): sentences of up to 15 words, simple words, one idea per question.",
  "- B4-B6 (upper primary): sentences of up to 22 words; word problems of two steps at most.",
  "- JHS: sentences of up to 30 words; multi-step problems allowed; BECE style and vocabulary.",
].join("\n");

const TASK_RULES = [
  "Your task: write one section of a school question paper for a teacher in a Ghanaian basic",
  "school, with its answer key and marking scheme. The teacher reviews every question before it is used.",
  "",
  "Rules:",
  "- Write exactly the number of questions asked for, all of the question type asked for, at the",
  "  class's level band. Follow the difficulty asked for (MIXED = roughly 30% easy, 50% medium, 20% hard).",
  "- Stay on the topics given. If a topic is too advanced for the level, write the simplest honest",
  "  questions on it at that level rather than leaving the level.",
  "- Follow the Ghana Education Service (GES) curriculum for the level.",
  "- Use everyday Ghanaian contexts: cedis and pesewas, market prices, trotro fares, farming, local",
  "  foods, football, school life. Use realistic amounts.",
  "- Never include religious, ethnic, political or tribal content, stereotypes, violence, or any real",
  '  person. Do not name pupils; say "a pupil" or use a common first name only if a story needs one.',
  "- Never reproduce a real past examination paper (WAEC, BECE) or a textbook question word for word.",
  "  Write original questions in that style.",
  '- Multiple choice (MCQ): exactly four options keyed A, B, C, D in that order, one correct answer,',
  '  three plausible wrong options, no "all of the above" or "none of the above", options of similar',
  "  length. Put the correct key in answer.key. Vary which letter is correct.",
  '- True or false: options null, answer.key "TRUE" or "FALSE".',
  "- Fill in and short answer: options null, answer.accepted lists every acceptable answer (for",
  '  example "0.5" and "1/2"). Show the blank in a fill-in question as ______.',
  "- Essay and structured: options null, answer null, and a markingScheme of points whose marks add",
  "  up exactly to the marks for one question. Structured questions may have parts (a), (b), (c).",
  "- For objective questions the markingScheme may be empty; the key is enough.",
  "- explanation: one or two sentences a pupil could read after answering, saying why the answer is",
  "  right. Work numbers out carefully; a wrong answer key is the worst possible mistake here.",
  "- Do not repeat a question, and do not repeat any stem listed under avoidStems.",
  "- Plain text only. No markdown, no emoji, no long dashes. British English spelling.",
  "",
  BANDS,
  "",
  "Return JSON only, in the shape you were given.",
].join("\n");

export const QUESTION_SECTION_PROMPT = registerPrompt({
  key: "questionSection",
  version: "1.0.0", // bump on ANY change to the text or to QUESTION_SECTION_SCHEMA
  description: "One question paper section with answers and marking scheme, as JSON.",
  prefix: (v) => [`You are a careful subject teacher helping staff at ${v.schoolName || "the school"}.`, "", TASK_RULES].join("\n"),
  tail: (v) => {
    const c = v.context;
    if (!c) return "";
    return [
      `Write ${c.section.count} ${c.section.type} question(s) for ${c.subjectName}, ${c.className} (${c.levelBand}), ${c.termName}.`,
      `Each question is worth ${c.section.marksEach} mark(s). Difficulty: ${c.section.difficulty}.`,
      c.teacherNote ? `The teacher adds: ${c.teacherNote}` : "",
      "",
      "Request:",
      JSON.stringify(c, null, 2),
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n");
  },
});

const CHECK_RULES = [
  "Your task: answer school test questions yourself, so a teacher can see whether a draft answer key",
  "is right. You are not shown the key.",
  "",
  "- For each question, work it out and give only your final answer.",
  "- Multiple choice: the letter A, B, C or D. True or false: TRUE or FALSE. Fill in: the word or",
  "  number that fills the blank.",
  "- Answer every question you are given, using its position number.",
  "",
  "Return JSON only, in the shape you were given.",
].join("\n");

export const QUESTION_CHECK_PROMPT = registerPrompt({
  key: "questionCheck",
  version: "1.0.0",
  description: "Independent answers to objective questions, for checking a key.",
  prefix: (v) => [`You are a careful subject teacher helping staff at ${v.schoolName || "the school"}.`, "", CHECK_RULES].join("\n"),
  tail: (v) =>
    v.context
      ? [`Subject: ${v.context.subjectName}. Level band: ${v.context.levelBand}.`, "", "Request:", JSON.stringify(v.context, null, 2)].join("\n")
      : "",
});

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

/** JSON Schema for one generated section (sent as responseJsonSchema and checked by run.js). */
export const QUESTION_SECTION_SCHEMA = {
  title: "QuestionSection",
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["stem", "options", "answer", "markingScheme", "explanation", "difficulty"],
        properties: {
          stem: { type: "string", maxLength: 2000 },
          options: nullable({
            type: "array",
            items: {
              type: "object",
              required: ["key", "text"],
              properties: { key: { type: "string", enum: ["A", "B", "C", "D"] }, text: { type: "string", maxLength: 400 } },
            },
          }),
          answer: nullable({
            type: "object",
            properties: {
              key: nullable({ type: "string" }),
              accepted: nullable({ type: "array", items: { type: "string" } }),
            },
          }),
          markingScheme: {
            type: "array",
            items: {
              type: "object",
              required: ["point", "marks"],
              properties: { point: { type: "string", maxLength: 500 }, marks: { type: "number" } },
            },
          },
          explanation: nullable({ type: "string", maxLength: 1000 }),
          difficulty: { type: "string", enum: ["EASY", "MEDIUM", "HARD"] },
        },
      },
    },
  },
};

export const ANSWER_CHECK_SCHEMA = {
  title: "AnswerCheck",
  type: "object",
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["position", "answer"],
        properties: { position: { type: "integer" }, answer: { type: "string", maxLength: 200 } },
      },
    },
  },
};
