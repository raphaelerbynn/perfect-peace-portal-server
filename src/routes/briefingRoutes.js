import { Router } from "express";
import { featureBlockReason, requireAiFeature } from "../services/ai/gate.js";
import { getBriefing, latestBriefing, listBriefings, runBriefing } from "../services/briefing/service.js";
import { getBriefingSettings, settingsView, updateBriefingSettings } from "../services/briefing/settings.js";
import { accraParts, nextRunAt } from "../services/briefing/schedule.js";
import { AiBriefing } from "../models/index.js";
import { authenticateManagementUser, requirePermission } from "../utils/middlewares.js";
import { P } from "../utils/permissions.js";

// AI-5: the Monday briefing (/ai/briefings*), for roles holding ai.briefing
// (the Administrator). Reading past briefings and the settings works
// with AI switched off; "Run now" needs the BRIEFING feature on (not the
// budget: over the cap it still makes the plain briefing). Auth per route, so
// mounted next to aiRouter in src/index.js.
const router = Router();
const BRIEFING = [authenticateManagementUser, requirePermission(P.AI_BRIEFING)];

const send = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    next(error);
  }
};

const scheduleState = async (settings, now = new Date()) => {
  const today = await AiBriefing.findOne({ where: { runKey: accraParts(now).date }, attributes: ["status"], raw: true }).catch(() => null);
  const next = nextRunAt(now, settings, { doneToday: Boolean(today && today.status !== "RUNNING") });
  const reason = await featureBlockReason("BRIEFING");
  return { nextRunAt: next ? next.toISOString() : null, available: !reason, reason };
};

// Latest briefing for the dashboard card (+ whether today's is being made, and when the next is due).
router.get("/ai/briefings/latest", ...BRIEFING, send(async () => {
  const [latest, settings] = await Promise.all([latestBriefing(), getBriefingSettings()]);
  return { ...latest, ...(await scheduleState(settings)), schedule: settingsView(settings).schedule };
}));

// Schedule and delivery settings.
router.get("/ai/briefings/settings", ...BRIEFING, send(async () => {
  const settings = await getBriefingSettings();
  return { ...settingsView(settings), ...(await scheduleState(settings)) };
}));
router.put("/ai/briefings/settings", ...BRIEFING, send(async (req) => {
  const settings = await updateBriefingSettings(req.body || {}, { username: req.user.username });
  return { ...settingsView(settings), ...(await scheduleState(settings)) };
}));

// Run now: makes today's briefing, replacing today's if there is one.
router.post("/ai/briefings/run", ...BRIEFING, requireAiFeature("BRIEFING", { budget: false }), send((req) => runBriefing({ trigger: "MANUAL", user: req.user })));

// History.
router.get("/ai/briefings", ...BRIEFING, send((req) => listBriefings(req.query)));
router.get("/ai/briefings/:id", ...BRIEFING, send((req) => getBriefing(req.params.id)));

export { router as briefingRouter };
