// AI-0: every prompt module is imported here so it registers at start-up.
// A new feature adds its file (e.g. ./announcement.js) and one import line.
export * from "./registry.js";
export { schoolPreamble, toneLines, GENERAL_PROMPT } from "./base.js";
// AI-1
import "./ask.js";
