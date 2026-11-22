// AI-1: the few questions asked over and over, answered with no AI at all
// (ported from SchoolPro chat/fast-path.ts). A hit costs nothing (no model
// call, no Ai_usage_log row, nothing against the monthly cap), takes one
// database round trip and can't get the arithmetic wrong.
//
// Deliberately narrow: a matcher that fires on a question it only half
// understands gives a confident answer to a question nobody asked. So any
// class, date, comparison, ranking or second question is a miss, and a miss
// goes to the model in silence. What's left: whole-school pupil and staff
// counts and the current term.
import { invokeTool } from "./tools.js";

/** Lower-cased, quotes dropped, whitespace collapsed; end punctuation only (a "?" mid-way = two questions). */
export const normaliseQuestion = (question) =>
  String(question ?? "")
    .toLowerCase()
    .replace(/[?!.]+\s*$/, "")
    .replace(/[`'"“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const DISQUALIFIERS = [
  /\b(?:class|basic|primary|jhs|kg|nursery|creche|form|grade|stage)\s*\d/,
  /\b(?:in|for|of)\s+(?:class|basic|primary|jhs|kg|nursery|creche)\b/,
  /\b(?:last|next|this|previous)\s+(?:week|month|term|year|monday|friday)\b/,
  /\b(?:yesterday|today|tomorrow)\b/,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  /\b(?:compared|versus|vs|against|trend|why|change[sd]?|since|between|before|after)\b/,
  /\band\b/,
  /\?/,
  /\b(?:top|best|worst|highest|lowest|most|least|rank|ranking)\b/,
  /\d/,
];

const fmt = (n) => Number(n || 0).toLocaleString("en-GB");
const count = (n, one, many) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;

const RULES = [
  {
    id: "pupils_total",
    pattern:
      /^(?:how many (?:students|pupils|learners|children)(?: (?:do we have|have we got|are there|are on (?:the )?roll|are enrolled|in total|in the school|in school|does the school have))?|total (?:number of )?(?:students|pupils)|(?:student|pupil) count|number of (?:students|pupils)|roll size)$/,
    tool: "students_count",
    render: (r) => {
      if (!Number.isFinite(r?.pupilsOnRoll)) return null;
      return [
        `**${fmt(r.pupilsOnRoll)}** ${r.pupilsOnRoll === 1 ? "pupil is" : "pupils are"} on the roll (${count(r.boys, "boy", "boys")}, ${count(r.girls, "girl", "girls")}) across ${count(r.classes, "class", "classes")}.`,
        "",
        "Graduated and left classes are not counted.",
      ].join("\n");
    },
  },
  {
    id: "staff_total",
    pattern:
      /^(?:how many (?:staff|teachers|workers|employees)(?: members)?(?: (?:do we have|have we got|are there|in total|in the school|does the school have))?|total (?:number of )?(?:staff|teachers)|staff count|number of (?:staff|teachers))$/,
    tool: "staff_count",
    render: (r) => {
      if (!Number.isFinite(r?.totalStaff)) return null;
      return `**${fmt(r.totalStaff)}** ${r.totalStaff === 1 ? "member of staff is" : "staff are"} on the books.`;
    },
  },
  {
    id: "current_term",
    pattern:
      /^(?:what term is it(?: now)?|which term (?:is it|are we in)(?: now)?|what is the (?:current|present) term|what term are we in(?: now)?|current term|which term is (?:open|running))$/,
    tool: "current_term",
    render: (r) => {
      if (!r || !("currentTerm" in r)) return null;
      const t = r.currentTerm;
      if (!t) return "No term is open right now. An Administrator opens one in Settings → Terms.";
      const dates = t.startDate && t.endDate ? ` It runs from ${t.startDate} to ${t.endDate}.` : "";
      return `It is **${t.name}**.${dates}`;
    },
  },
];

export const FAST_PATH_RULE_IDS = RULES.map((r) => r.id);

/**
 * { text, toolsUsed } without a model, or null (falls through to the model).
 * Null on every doubt, including a tool the caller's role may not use.
 */
export const tryFastPath = async (question, { user } = {}) => {
  const text = normaliseQuestion(question);
  if (!text || text.length > 80 || DISQUALIFIERS.some((re) => re.test(text))) return null;
  const rule = RULES.find((r) => r.pattern.test(text));
  if (!rule) return null;
  let result;
  try {
    result = await invokeTool(rule.tool, {}, { user });
  } catch {
    return null;
  }
  const rendered = rule.render(result);
  return rendered ? { text: rendered, toolsUsed: [rule.tool], ruleId: rule.id } : null;
};
