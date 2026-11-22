// AI-8: a notice for the news feed (title + body) or an SMS (text), drafted
// from the office's purpose, audience and key facts, in the school's tone
// (Settings -> AI). Ported from SchoolPro's announcement.prompt.ts.
//
// The key facts are the only specifics that exist: the service checks every
// date and time in the answer against them (utils/dateGuard.js).
import { registerPrompt } from "./registry.js";
import { schoolPreamble, toneLines } from "./base.js";

export const ANNOUNCEMENT_LENGTHS = {
  short: "about 60 to 100 words",
  medium: "about 100 to 180 words",
  long: "about 180 to 300 words",
};

const RULES = [
  "Your task: write one notice for this school, for a member of staff to read, edit and then publish or send.",
  "You are given what the notice is for, who it is going to and a list of key facts. The key facts are the only specifics that exist.",
  "",
  "What you must not do:",
  "- Do not invent a date, a day of the week, a time, a year, a deadline, a venue, a fee, a phone number, an email address or a person's name. If it is not in the key facts, it does not exist.",
  '- Do not turn a vague fact into a precise one: "next week" does not become a date, "the head" does not become a name.',
  "- Do not add a detail because notices usually have one. Where a missing detail would leave the reader stuck, say it will be confirmed.",
  "- No placeholders such as [date] or TBC in square brackets, no signature, no postscript.",
  "",
  "How to write it:",
  "- Lead with what the reader has to know or do.",
  "- Repeat every date, time and amount from the key facts exactly as it was given. Do not reword \"3:30pm\" as \"half past three\".",
  "- The school is \"we\".",
  "",
  "Return JSON only, in the shape you were given.",
].join("\n");

const NEWS_RULES = [
  "This notice goes on the school's news feed (the portal).",
  "The title is a short headline that names the thing (not the school name, no date prefix).",
  "The body is in short paragraphs separated by a blank line.",
].join("\n");

const smsRules = (maxChars, shortName) =>
  [
    `This notice is an SMS to parents' phones. It must be at most ${maxChars} characters in total, including spaces.`,
    "One short message, no title, no blank lines. Plain characters only: straight quotes, no emoji, no curly quotes, write GHC for cedis.",
    `Start with the salutation if there is room; if it would not fit, a shorter "Dear Parent" is fine. End with the school's short name${shortName ? ` ("${shortName}")` : ""}.`,
  ].join("\n");

export const ANNOUNCEMENT_PROMPT = registerPrompt({
  key: "announcement",
  version: "1.0.0", // bump on ANY text change
  description: "AI-8: a news post or SMS notice from purpose, audience and key facts, as JSON.",
  prefix: (v) =>
    [
      schoolPreamble(v),
      ...toneLines(v.tone),
      "",
      RULES,
      "",
      v.mode === "sms" ? smsRules(v.maxChars, v.shortName) : NEWS_RULES,
    ].join("\n"),
  tail: (v) => {
    const facts = v.keyFacts || [];
    return [
      `Audience: ${v.audience || "parents and guardians"}.`,
      "",
      "What this notice is for:",
      v.purpose,
      "",
      facts.length ? "Key facts, the only specifics you may state:" : "No key facts were given. Write it without any date, time, venue, amount or name at all.",
      ...facts.map((f) => `- ${f}`),
      "",
      v.mode === "sms"
        ? `Write the SMS now (at most ${v.maxChars} characters).`
        : `Write the title and the body now (${ANNOUNCEMENT_LENGTHS[v.length] || ANNOUNCEMENT_LENGTHS.medium}).`,
    ].join("\n");
  },
});
