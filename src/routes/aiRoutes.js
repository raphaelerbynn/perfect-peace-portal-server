import { Router } from "express";
import { aiStatusFor } from "../services/ai/gate.js";
import { getAiSettingsForAdmin, updateAiSettings } from "../services/ai/settings.js";
import { acceptSuggestion, editSuggestion, getSuggestion, listSuggestions, rejectSuggestion } from "../services/ai/suggestions.js";
import { actorOf, usageSummary } from "../services/ai/usage.js";
import { requireAiFeature } from "../services/ai/gate.js";
import { draftAnnouncement } from "../services/aiAnnouncements.js";
import { authenticateManagementUser, authenticateUser, requirePermission } from "../utils/middlewares.js";
import { P } from "../utils/permissions.js";
// AI-1
import { deleteMyConversation, getMyConversation, getMyConversations, postAsk } from "../controllers/askController.js";

// AI-0: the shared AI endpoints (/ai/*). Mounted with the routers that
// authenticate per route (before teacherRouter), because GET /ai/status serves
// portal AND office tokens. Everything else is office only, each route gated
// by a B10 permission (src/utils/permissions.js, module "ai").
// Feature routes (AI-1 /ai/ask, AI-3 /teacher/papers ...) live with their
// feature and use requireAiFeature("<FEATURE>").
//
// Reviewing drafts does not need AI switched on: switching AI off must never
// strand drafts that are already waiting.
const router = Router();
const office = (key) => [authenticateManagementUser, requirePermission(key)];

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

// Any signed-in user: which AI features they can use right now.
router.get("/ai/status", authenticateUser, send((req) => aiStatusFor(req.user)));

// Settings -> AI, and usage with its amounts (ai.settings).
router.get("/ai/settings", ...office(P.AI_SETTINGS), send(() => getAiSettingsForAdmin()));
router.put("/ai/settings", ...office(P.AI_SETTINGS), send((req) => updateAiSettings(req.body || {}, { username: req.user.username })));
router.get("/ai/usage", ...office(P.AI_SETTINGS), send(() => usageSummary()));

// Office drafts (ai.suggestions.review). Accepting runs the feature's handler
// as the caller, which checks its own permission too (an announcement becomes
// a news post only with news.manage).
const REVIEW = office(P.AI_SUGGESTIONS_REVIEW);
router.get("/ai/suggestions", ...REVIEW, send((req) => listSuggestions(req.query)));
router.get("/ai/suggestions/:id", ...REVIEW, send((req) => getSuggestion(req.params.id)));
router.patch("/ai/suggestions/:id", ...REVIEW, send((req) => editSuggestion(req.params.id, req.body?.content, { actor: actorOf(req.user) })));
router.post("/ai/suggestions/:id/accept", ...REVIEW, send((req) => acceptSuggestion(req.params.id, { actor: actorOf(req.user), user: req.user })));
router.post("/ai/suggestions/:id/reject", ...REVIEW, send((req) => rejectSuggestion(req.params.id, { actor: actorOf(req.user) })));

// AI-8: draft a news post or an SMS (ai.announcements). Accept / edit /
// reject: the /ai/suggestions endpoints above (accept makes a DRAFT post, or
// returns the SMS text).
router.post(
  "/ai/announcements/draft",
  ...office(P.AI_ANNOUNCEMENTS),
  requireAiFeature("ANNOUNCEMENTS"),
  send((req) => draftAnnouncement(req.body || {}, req.user))
);

// AI-1: Ask the school (ai.ask; the tools offered follow the role's other
// permissions, so the Accountant gets the finance tools only). Streams SSE.
// The budget is checked inside, after the free fast path, so "how many
// pupils" still answers over the cap. History needs ai.ask only: past answers
// stay readable while AI is switched off, and each user sees only their own
// conversations.
const ASK = office(P.AI_ASK);
router.post("/ai/chat", ...ASK, requireAiFeature("ASK", { budget: false }), postAsk);
router.get("/ai/conversations", ...ASK, getMyConversations);
router.get("/ai/conversations/:id", ...ASK, getMyConversation);
router.delete("/ai/conversations/:id", ...ASK, deleteMyConversation);

export { router as aiRouter };
