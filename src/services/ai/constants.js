// AI-0: names shared by every AI feature. See README.md in this folder.

// Feature keys. Used as Ai_usage_log.feature, Ai_suggestion.feature and the
// keys of Ai_settings.feature_toggles. A new key needs no migration.
export const AI_FEATURES = Object.freeze({
  ASK: "ASK", // AI-1 Ask the school
  PAPERS: "PAPERS", // AI-3 question papers (teachers, portal)
  BRIEFING: "BRIEFING", // AI-5 Monday briefing
  ANNOUNCEMENTS: "ANNOUNCEMENTS", // AI-8 announcement drafts
  AT_RISK: "AT_RISK", // AI-4 pupils-at-risk watchlist notes
  // Later (switches exist, off by default, no code yet).
  REMARKS: "REMARKS",
  EXPLAIN: "EXPLAIN",
  DOCUMENTS: "DOCUMENTS",
});
export const AI_FEATURE_KEYS = Object.freeze(Object.values(AI_FEATURES));

// What the Settings -> AI page shows, plus each feature's default switch (a
// missing key in Ai_settings.feature_toggles uses this) and who may use it:
//   `permission` = the B10 permission an office login's role must hold
//                  (src/utils/permissions.js; the routes gate on the same key);
//   `portal`     = portal userRoles (STAFF = teachers), unchanged by B10.
// requireAiFeature() and aiStatusFor() read it (gate.js#featureAllowed).
// The parked features have no routes yet: they follow ai.settings (whoever
// runs AI) until they are built and get their own key.
export const AI_FEATURE_INFO = Object.freeze({
  ASK: {
    label: "Ask the school",
    description: "Ask a question about pupils, attendance, results or fees and get an answer from the school's own records.",
    defaultOn: true,
    permission: "ai.ask", // AI-1: the tools offered follow the role's other permissions (ask/tools.js)
    portal: [],
  },
  PAPERS: {
    label: "Question papers",
    description: "Teachers draft class exercises and test papers from a topic; the teacher checks every question.",
    defaultOn: true,
    // Office: the read-only view of every paper; teachers write theirs in the portal.
    permission: "ai.papers.view_all",
    portal: ["STAFF"],
  },
  BRIEFING: {
    label: "Monday briefing",
    description: "A short weekly summary for the head teacher: attendance, fees, results, things to look at.",
    defaultOn: true,
    permission: "ai.briefing",
    portal: [],
  },
  ANNOUNCEMENTS: {
    label: "Announcement drafts",
    description: "Turn a few notes into a notice for parents in the school's tone.",
    defaultOn: true,
    permission: "ai.announcements",
    portal: [],
  },
  REMARKS: {
    label: "Report card remarks",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    permission: "ai.settings",
    portal: [],
  },
  AT_RISK: {
    label: "Pupils at risk",
    description: "A short note on each pupil on the at-risk watchlist (attendance, scores, fees): why they are on it and what to do first. The list itself works without AI.",
    defaultOn: true,
    // AI-4: without academics.all_classes, the login's own class only (the
    // watchlist service checks the class).
    permission: "ai.at_risk",
    portal: [],
  },
  EXPLAIN: {
    label: "Result explanations",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    permission: "ai.settings",
    portal: [],
  },
  DOCUMENTS: {
    label: "Read scanned documents",
    description: "Not built yet.",
    defaultOn: false,
    later: true,
    permission: "ai.settings",
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
