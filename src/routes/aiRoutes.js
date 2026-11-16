import { Router } from "express";
import { aiStatusFor } from "../services/ai/gate.js";
import { getAiSettingsForAdmin, updateAiSettings } from "../services/ai/settings.js";
import { acceptSuggestion, editSuggestion, getSuggestion, listSuggestions, rejectSuggestion } from "../services/ai/suggestions.js";
import { actorOf, usageSummary } from "../services/ai/usage.js";
import { authenticateManagementUser, authenticateUser, authorizeRoles } from "../utils/middlewares.js";
// AI-1
import { deleteMyConversation, getMyConversation, getMyConversations, postAsk } from "../controllers/askController.js";
import { requireAiFeature } from "../services/ai/gate.js";
import { AI_FEATURE_INFO } from "../services/ai/constants.js";

// AI-0: the shared AI endpoints (/ai/*). Mounted with the routers that
// authenticate per route (before teacherRouter), because GET /ai/status serves
// portal AND office tokens. Everything else is office + Administrator.
// Feature routes (AI-1 /ai/ask, AI-3 /teacher/papers ...) live with their
// feature and use requireAiFeature("<FEATURE>").
//
// Reviewing drafts does not need AI switched on: switching AI off must never
// strand drafts that are already waiting.
const router = Router();
const ADMIN = [authenticateManagementUser, authorizeRoles("Administrator")];

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

// Any signed-in user: which AI features they can use right now.
router.get("/ai/status", authenticateUser, send((req) => aiStatusFor(req.user)));

// Settings -> AI (Administrator).
router.get("/ai/settings", ...ADMIN, send(() => getAiSettingsForAdmin()));
router.put("/ai/settings", ...ADMIN, send((req) => updateAiSettings(req.body || {}, { username: req.user.username })));
router.get("/ai/usage", ...ADMIN, send(() => usageSummary()));

// Drafts (Administrator).
router.get("/ai/suggestions", ...ADMIN, send((req) => listSuggestions(req.query)));
router.get("/ai/suggestions/:id", ...ADMIN, send((req) => getSuggestion(req.params.id)));
router.patch("/ai/suggestions/:id", ...ADMIN, send((req) => editSuggestion(req.params.id, req.body?.content, { actor: actorOf(req.user) })));
router.post("/ai/suggestions/:id/accept", ...ADMIN, send((req) => acceptSuggestion(req.params.id, { actor: actorOf(req.user) })));
router.post("/ai/suggestions/:id/reject", ...ADMIN, send((req) => rejectSuggestion(req.params.id, { actor: actorOf(req.user) })));

// AI-1: Ask the school (Administrator + Accountant; the Accountant gets the
// finance tools only). Streams SSE. The budget is checked inside, after the
// free fast path, so "how many pupils" still answers over the cap. History is
// role-checked only: past answers stay readable while AI is switched off, and
// each user sees only their own conversations.
const ASK_ROLES = [authenticateManagementUser, authorizeRoles(...AI_FEATURE_INFO.ASK.office)];
router.post("/ai/chat", requireAiFeature("ASK", { budget: false }), postAsk);
router.get("/ai/conversations", ...ASK_ROLES, getMyConversations);
router.get("/ai/conversations/:id", ...ASK_ROLES, getMyConversation);
router.delete("/ai/conversations/:id", ...ASK_ROLES, deleteMyConversation);

export { router as aiRouter };
