import { Router } from "express";
import { requireAiFeature } from "../services/ai/gate.js";
import { getWatchlist, setStatus, writeNotes } from "../services/atRisk/service.js";
import { authenticateManagementUser, requirePermission } from "../utils/middlewares.js";
import { P } from "../utils/permissions.js";

// AI-4: the pupils-at-risk watchlist (/ai/watchlist*), for roles holding
// ai.at_risk: school-wide with academics.all_classes (the Administrator),
// else the login's own class only (the Class Teacher; checked in the service).
// The list and the handled / dismissed marks work with AI switched off and
// over the cap; only "Write AI notes" needs the AT_RISK feature on and the
// budget. Auth per route, so mounted next to aiRouter in src/index.js.
const router = Router();
const WATCHLIST = [authenticateManagementUser, requirePermission(P.AI_AT_RISK)];

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

router.get("/ai/watchlist", ...WATCHLIST, send((req) => getWatchlist({ user: req.user, query: req.query })));
router.post("/ai/watchlist/notes", ...WATCHLIST, requireAiFeature("AT_RISK"), send((req) => writeNotes({ user: req.user, body: req.body || {} })));
router.put("/ai/watchlist/:studentId/status", ...WATCHLIST, send((req) => setStatus({ user: req.user, studentId: req.params.studentId, body: req.body || {} })));

export { router as atRiskRouter };
