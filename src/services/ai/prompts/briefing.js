// AI-5: the Monday briefing prompt (ported from SchoolPro's briefing.prompt.ts).
// The model only ranks and writes up signals that were measured in SQL first;
// services/briefing/service.js throws the answer away if it quotes a number
// it wasn't given. Bump the version on ANY change to the text or the schema.
import { registerPrompt } from "./registry.js";
import { schoolPreamble } from "./base.js";

export const BRIEFING_LENGTHS = Object.freeze({
  headline: [10, 140],
  summary: [30, 600],
  itemHeadline: [5, 120],
  itemBody: [20, 600],
  itemAction: [10, 300],
});

export const briefingOutputSchema = (maxItems) => ({
  type: "object",
  required: ["headline", "summary", "items"],
  properties: {
    headline: { type: "string", maxLength: BRIEFING_LENGTHS.headline[1], description: "One line naming the most important thing. No figure that was not supplied." },
    summary: { type: "string", maxLength: BRIEFING_LENGTHS.summary[1], description: "Two to four sentences the head teacher can read in twenty seconds." },
    items: {
      type: "array",
      maxItems,
      description: "The signals worth writing up, most important first. Fewer than you were given is fine.",
      items: {
        type: "object",
        required: ["signalKey", "headline", "body", "whatToDoNext"],
        properties: {
          signalKey: { type: "string", description: "Copied exactly from the signal this item is about." },
          headline: { type: "string", maxLength: BRIEFING_LENGTHS.itemHeadline[1] },
          body: { type: "string", maxLength: BRIEFING_LENGTHS.itemBody[1], description: "What happened and why it matters, using only this signal's figures." },
          whatToDoNext: { type: "string", maxLength: BRIEFING_LENGTHS.itemAction[1], description: "One concrete step for this week, naming who does it." },
        },
      },
    },
  },
});

const TASK_RULES = [
  "Task: write the weekly briefing for the head teacher.",
  "You are given signals. Each was already measured from the school's records: a key, a plain statement and the exact figures.",
  "Your job is to rank them and write them up. Nothing else.",
  "- Do not compute anything: no adding, averaging, converting or estimating. A number that is not in the figures may not appear in your text. Every number you write is checked, and a briefing with a number that was not supplied is thrown away.",
  "- Quote figures exactly as given: 82.4 stays 82.4. Money as given, e.g. GH₵ 1,250.00.",
  "- Rank by what the head teacher should act on first. A pupil who has just crossed the chronic absence line outranks a total, because it can still be fixed this week.",
  "- Write fewer items than you were given when the rest don't deserve attention.",
  "- Each item needs one concrete next step, naming who does it (class teacher, bursar, head teacher). \"Continue to monitor\" is not a next step.",
  "- Name pupils, staff and classes plainly: only the head teacher reads this.",
  "- No blame and no guessing why something happened.",
  "- Copy each signalKey exactly; an item whose key was not given is discarded.",
  "Return JSON only, in the shape given.",
].join("\n");

export const BRIEFING_PROMPT = registerPrompt({
  key: "briefing",
  version: "1.0.0",
  description: "Monday briefing: ranks and writes up pre-computed signals, as JSON.",
  prefix: (v) => [schoolPreamble(v), "", TASK_RULES].join("\n"),
  tail: (v) =>
    [
      `Period: the 7 days from ${v.window.from} to ${v.window.to}${v.window.termLabel ? ` (${v.window.termLabel})` : ""}.`,
      `Comparisons are against the ${v.window.baselineWeeks} weeks before.`,
      `Signals: ${v.signals.length}. Write at most ${v.maxItems} items.`,
      "",
      "Signals, most severe first:",
      JSON.stringify(v.signals, null, 2),
    ].join("\n"),
});
