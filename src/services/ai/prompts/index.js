// AI-0: every prompt module is imported here so it registers at start-up.
// A new feature adds its file (e.g. ./announcement.js) and one import line.
export * from "./registry.js";
export { schoolPreamble, toneLines, GENERAL_PROMPT } from "./base.js";
import "./announcement.js"; // AI-8

// AI-1
import "./ask.js";
// AI-3 question papers (section + blind answer check)
import "./questionPaper.js";
// AI-5
export { BRIEFING_PROMPT, BRIEFING_LENGTHS, briefingOutputSchema } from "./briefing.js";
// AI-4
export { AT_RISK_PROMPT, AT_RISK_LENGTHS, atRiskOutputSchema } from "./atRisk.js";
