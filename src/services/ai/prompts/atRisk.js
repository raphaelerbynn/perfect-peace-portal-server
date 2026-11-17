// AI-4: a short note per pupil on the at-risk watchlist (ported from
// SchoolPro's watchlist prompt in improvement.prompt.ts). Who is on the list,
// the order and every figure are computed first; the model only words "why
// flagged, suggested next step". services/atRisk/service.js rejects a note
// that quotes a number it wasn't given. Bump the version on ANY change.
import { registerPrompt } from "./registry.js";
import { schoolPreamble } from "./base.js";

export const AT_RISK_LENGTHS = Object.freeze({
  note: [20, 400],
  nextStep: [10, 300],
});

export const atRiskOutputSchema = (maxPupils) => ({
  type: "object",
  required: ["pupils"],
  properties: {
    pupils: {
      type: "array",
      maxItems: maxPupils,
      description: "One entry per pupil given, none added.",
      items: {
        type: "object",
        required: ["key", "note", "nextStep"],
        properties: {
          key: { type: "string", description: "Copied exactly from the pupil this entry is about." },
          note: { type: "string", maxLength: AT_RISK_LENGTHS.note[1], description: "One or two sentences: why the pupil is on the list, using only their figures." },
          nextStep: { type: "string", maxLength: AT_RISK_LENGTHS.nextStep[1], description: "One concrete step for this week, naming who does it." },
        },
      },
    },
  },
});

const TASK_RULES = [
  "Task: write a short note for each pupil on the school's at-risk watchlist. Only staff read it (the head teacher and the pupil's class teacher).",
  "Who is on the list, and every figure, was already worked out from the school's records. Each pupil comes with reasons: a plain statement and the exact figures.",
  "For each pupil write:",
  "- note: one or two sentences saying why the pupil is on the list, from the reasons, most serious first.",
  "- nextStep: one concrete thing to do this week, naming who does it (class teacher, head teacher, bursar, subject teacher). \"Continue to monitor\" is not a step.",
  "Rules:",
  "- Do not compute anything: no adding, averaging or rounding. A number that is not in that pupil's figures may not appear in their note. Every number is checked, and a note with a number that was not supplied is thrown away.",
  "- Quote figures exactly as given: 82.5 stays 82.5. Money as given, e.g. GH₵ 450.00.",
  "- Write about the figures, never about the child as a person: no 'lazy', 'weak', 'not trying', no guesses about ability, home, health or money worries.",
  "- Attendance, scores and fees are separate facts. Never say one caused another.",
  "- Do not compare the pupil with other pupils, and do not say they should or should not be on the list.",
  "- Use the pupil's first name or 'the pupil'. Copy each key exactly; an entry for a key that was not given is thrown away.",
  "Return JSON only, in the shape given.",
].join("\n");

export const AT_RISK_PROMPT = registerPrompt({
  key: "atRisk",
  version: "1.0.0",
  description: "Pupils-at-risk watchlist: one short note and next step per pre-computed entry, as JSON.",
  prefix: (v) => [schoolPreamble(v), "", TASK_RULES].join("\n"),
  tail: (v) =>
    [
      `Term: ${v.termLabel}.`,
      `Pupils: ${v.pupils.length}. Write one entry for each.`,
      "",
      "Pupils, most at risk first:",
      JSON.stringify(v.pupils, null, 2),
    ].join("\n"),
});
