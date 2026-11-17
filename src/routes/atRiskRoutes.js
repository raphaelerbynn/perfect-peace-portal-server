import { Router } from "express";
import { requireAiFeature } from "../services/ai/gate.js";
import { WATCHLIST_ROLES, getWatchlist, setStatus, writeNotes } from "../services/atRisk/service.js";
import { authenticateManagementUser, authorizeRoles } from "../utils/middlewares.js";

// AI-4: the pupils-at-risk watchlist (/ai/watchlist*). Administrator
// (school-wide) and Class Teacher (own class only, checked in the service).
// The list and the handled / dismissed marks work with AI switched off and
// over the cap; only "Write AI notes" needs the AT_RISK feature on and the
// budget. Auth per route, so mounted next to aiRouter in src/index.js.
const router = Router();
const STAFF = [authenticateManagementUser, authorizeRoles(...WATCHLIST_ROLES)];

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

router.get("/ai/watchlist", ...STAFF, send((req) => getWatchlist({ user: req.user, query: req.query })));
router.post("/ai/watchlist/notes", ...STAFF, requireAiFeature("AT_RISK"), send((req) => writeNotes({ user: req.user, body: req.body || {} })));
router.put("/ai/watchlist/:studentId/status", ...STAFF, send((req) => setStatus({ user: req.user, studentId: req.params.studentId, body: req.body || {} })));

export { router as atRiskRouter };
