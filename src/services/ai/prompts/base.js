// AI-0: the shared opening every staff-facing prompt builds on. A feature's
// prompt calls schoolPreamble(vars) at the top of its prefix and adds its own
// task rules; it never restates who the assistant is.
//
// The rules here are about quality and scope. They are NOT the defence
// against leaking contact data: that is redact.js, applied before this.
import { DEFAULT_TONE } from "../constants.js";
import { registerPrompt } from "./registry.js";

/** The tone settings (Settings -> AI) as instructions. Used by AI-8 notices. */
export const toneLines = (tone = {}) => {
  const t = { ...DEFAULT_TONE, ...(tone || {}) };
  return [
    t.formal
      ? "Tone: formal. Full sentences, no contractions, no exclamation marks, no slang."
      : "Tone: warm and friendly, but still professional. Contractions are fine.",
    t.britishSpelling ? "Spelling: British English (colour, organise, programme, centre)." : "Spelling: American English.",
    t.salutation ? `When writing to parents, open with "${t.salutation}".` : "",
  ].filter(Boolean);
};

export const schoolPreamble = ({ schoolName = "the school", today } = {}) =>
  [
    `You are the assistant for ${schoolName}, a basic school in Ghana (nursery, kindergarten, primary and JHS).`,
    "Money is in Ghana cedis, written GH₵ 1,234.00. Terms are Term 1, Term 2 and Term 3.",
    today ? `Today is ${today}.` : "",
    "Rules:",
    "- Use only the facts you are given. If something is not in them, say you don't have it; never guess names, numbers or dates.",
    "- Everything you write is a draft that a member of staff will check before anyone else sees it.",
    "- Never include phone numbers, email addresses, home addresses or passwords.",
    "- Plain, clear English that a busy head teacher or parent can read quickly.",
  ]
    .filter(Boolean)
    .join("\n");

// A plain prompt for one-off text tasks and smoke tests (e.g. the Settings ->
// AI page's future "test the connection" button). Features register their own.
export const GENERAL_PROMPT = registerPrompt({
  key: "general",
  version: "1.0.0",
  description: "School preamble + one task (no tools).",
  prefix: (vars) => [schoolPreamble(vars), ...(vars.tone ? toneLines(vars.tone) : [])].join("\n"),
  tail: (vars) => String(vars.task || ""),
});
