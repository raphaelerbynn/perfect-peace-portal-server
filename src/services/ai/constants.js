// AI-0: names shared by every AI feature. See README.md in this folder.

// Feature keys. Used as Ai_usage_log.feature, Ai_suggestion.feature and the
// keys of Ai_settings.feature_toggles. A new key needs no migration.
export const AI_FEATURES = Object.freeze({
  ASK: "ASK", // AI-1 Ask the school
  PAPERS: "PAPERS", // AI-3 question papers (teachers, portal)
  BRIEFING: "BRIEFING", // AI-5 Monday briefing
  ANNOUNCEMENTS: "ANNOUNCEMENTS", // AI-8 announcement drafts
  // Later (switches exist, off by default, no code yet).
  REMARKS: "REMARKS",
  AT_RISK: "AT_RISK",
  EXPLAIN: "EXPLAIN",
  DOCUMENTS: "DOCUMENTS",
});
export const AI_FEATURE_KEYS = Object.freeze(Object.values(AI_FEATURES));

// What the Settings -> AI page shows, plus each feature's default switch (a
// missing key in Ai_settings.feature_toggles uses this) and who may use it.
//
// PP has no permission system yet (B10 isn't built), so this table IS the
// permission check: `office` = management categories, `portal` = portal
// userRoles (STAFF = teachers). requireAiFeature() reads it. When B10 lands,
// swap the lookup in gate.js#roleAllowed for the permission middleware.
export const AI_FEATURE_INFO = Object.freeze({
  ASK: {
    label: "Ask the school",
    description: "Ask a question about pupils, attendance, results or fees and get an answer from the school's own records.",
    defaultOn: true,
    office: ["Administrator", "Accountant"], // AI-1 limits the Accountant to the finance tools
    portal: [],
  },
  PAPERS: {
    label: "Question papers",
    description: "Teachers draft class exercises and test papers from a topic; the teacher checks every question.",
    defaultOn: true,
    office: ["Administrator"],
    portal: ["STAFF"],
  },
  BRIEFING: {
    label: "Monday briefing",
    description: "A short weekly summary for the head teacher: attendance, fees, results, things to look at.",
    defaultOn: true,
    office: ["Administrator"],
    portal: [],
  },
  ANNOUNCEMENTS: {
    label: "Announcement drafts",
    description: "Turn a few notes into a notice for parents in the school's tone.",
    defaultOn: true,
    office: ["Administrator"],
    portal: [],
  },
  REMARKS: {
    label: "Report card remarks",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    office: ["Administrator"],
    portal: [],
  },
  AT_RISK: {
    label: "Pupils at risk",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    office: ["Administrator"],
    portal: [],
  },
  EXPLAIN: {
    label: "Result explanations",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    office: ["Administrator"],
    portal: [],
  },
  DOCUMENTS: {
    label: "Read scanned documents",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    office: ["Administrator"],
    portal: [],
  },
});

// Provider failures, classified. RATE_LIMIT and TIMEOUT are retried with
// backoff; MALFORMED_OUTPUT gets one retry (generateJson only); SAFETY_BLOCK
// and AUTH never. QUOTA / DISABLED are our own refusals (logged as BLOCKED).
export const AI_ERROR_CLASSES = Object.freeze([
  "RATE_LIMIT",
  "TIMEOUT",
  "SAFETY_BLOCK",
  "MALFORMED_OUTPUT",
  "AUTH",
  "PROVIDER_ERROR",
  "UNKNOWN",
  "QUOTA",
  "DISABLED",
]);
export const RETRYABLE_ERROR_CLASSES = Object.freeze(["RATE_LIMIT", "TIMEOUT"]);

export const AI_USAGE_STATUSES = Object.freeze(["OK", "ERROR", "BLOCKED"]);

export const AI_SUGGESTION_STATUSES = Object.freeze(["PENDING", "EDITED", "ACCEPTED", "REJECTED"]);
export const AI_OPEN_SUGGESTION_STATUSES = Object.freeze(["PENDING", "EDITED"]);

// Tone for drafted notices (AI-8). Stored in Ai_settings.tone; missing keys use these.
export const DEFAULT_TONE = Object.freeze({
  formal: true,
  salutation: "Dear Parent/Guardian",
  britishSpelling: true,
});
